import { createHash, randomFillSync } from 'node:crypto'
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Router, bodyAsBuffer, bodyAsStream } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { formData, multipart } from '@caffeinejs/multipart'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { brewer, ErrBrewFollowUpNotSent, type Authenticator, type BrewClient, type BrewOptions } from '../index.js'
import { bodies, profileForm } from './_bodies.js'
import { Tokens } from './_tokens.js'

/**
 * Uploads that meet an expired token: forms with files, every kind of body, a large file from disk, a body the server
 * refuses before reading, and streams, opened by a function or passed as they are.
 *
 * Every route answers with what reached it, a body by its SHA-256, so each test asserts that a follow-up carried the
 * very bytes the first send did.
 */

const LARGE = 8 * 1024 * 1024
const ACCESS = 'Bearer fresh'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

type Part = { field: string; value: string } | { field: string; name: string; type: string; sha256: string }

interface Upload {
  authorization: string | null
  type: string | null
  size: number
  sha256: string | null
  parts?: Part[]
}

// What reached the server, upload by upload, in the order they arrived.
const uploads: Upload[] = []

// The upload the held route is reading: told when its first chunk arrived.
let reading: (() => void) | undefined

const dir = mkdtempSync(join(tmpdir(), 'brewer-auth-uploads-'))
const large = new Uint8Array(LARGE)
randomFillSync(large)
writeFileSync(join(dir, 'video.bin'), large)

interface Exchange {
  readonly req: { header(name: string): string | undefined }
  status(code: number): unknown
  header(name: string, value: string): unknown
}

async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of body) {
      // Dropped.
    }
  } catch {
    // The client stopped sending.
  }
}

function refused(ctx: Exchange): boolean {
  if (ctx.req.header('authorization') === ACCESS) {
    return false
  }
  ctx.status(401)
  ctx.header('www-authenticate', 'Bearer error="invalid_token"')
  return true
}

const files = new Router('/files')
  .post('/raw')
  .extend(bodyAsBuffer())
  .bodyLimit(2 * LARGE)
  .handler(ctx => {
    const bytes = ctx.req.body() as Uint8Array
    uploads.push({
      authorization: ctx.req.header('authorization') ?? null,
      type: ctx.req.header('content-type') ?? null,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })
    return refused(ctx) ? { error: 'invalid_token' } : { stored: bytes.byteLength }
  })
  .post('/form')
  .handler(async ctx => {
    const parts: Part[] = []
    for (const [field, value] of await formData(ctx).form()) {
      parts.push(
        typeof value === 'string'
          ? { field, value }
          : { field, name: value.name, type: value.type, sha256: sha256(await value.bytes()) },
      )
    }
    uploads.push({ authorization: ctx.req.header('authorization') ?? null, type: null, size: 0, sha256: null, parts })
    return refused(ctx) ? { error: 'invalid_token' } : { stored: parts.length }
  })
  // An authorization check that answers before the upload is read, as a gateway in front of the handler would.
  .put('/early')
  .extend(bodyAsStream())
  .bodyLimit(2 * LARGE)
  .handler(async ctx => {
    if (refused(ctx)) {
      uploads.push({ authorization: ctx.req.header('authorization') ?? null, type: null, size: 0, sha256: null })
      // Answered before a byte of it is read; the rest is read and dropped afterwards, as a server keeping the
      // connection alive does.
      void drain(ctx.req.body() as ReadableStream<Uint8Array>)
      return { error: 'invalid_token' }
    }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of ctx.req.body() as ReadableStream<Uint8Array>) {
      hash.update(chunk)
      size += chunk.byteLength
    }
    uploads.push({
      authorization: ctx.req.header('authorization') ?? null,
      type: null,
      size,
      sha256: hash.digest('hex'),
    })
    return { stored: size }
  })
  .put('/held')
  .extend(bodyAsStream())
  .handler(async ctx => {
    const reader = (ctx.req.body() as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    reading?.()
    try {
      while (!(await reader.read()).done) {
        // Read on until the upload ends, or breaks off.
      }
    } catch {
      // The client stopped sending.
    }
    return { done: true }
  })

const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .with(multipart(() => ({ limits: { fileSize: LARGE } })))
  .mount(files)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  uploads.length = 0
})

type Connect = (options?: BrewOptions) => BrewClient<typeof app>

/** Answers the first 401 with a token the server still refuses, the second with the one it takes. */
const twoRounds: Authenticator = (request, _response, attempt) => {
  request.headers.set('authorization', attempt === 1 ? 'Bearer still-expired' : ACCESS)
  return request
}

/** Answers the first 401 with the token the server takes. */
const oneRound: Authenticator = (request, _response, attempt) => {
  request.headers.set('authorization', ACCESS)
  return attempt === 1 ? request : null
}

const expired = { authorization: 'Bearer expired' }

const transports = [
  ['in process', ((options?: BrewOptions) => brewer(app, options)) as Connect],
  ['over a socket', ((options?: BrewOptions) => brewer<typeof app>(origin, options)) as Connect],
] as const

describe.each(transports)('brewer uploading under an expiring token, %s', (_transport, connect) => {
  describe('given a profile form with files', () => {
    // Each encoding of a form draws a boundary of its own: a follow-up that kept the first one's content type would
    // reach the server unreadable.
    it('should send it whole again on each follow-up, under a boundary its encoding names', async () => {
      const client = connect({ headers: expired, authenticator: twoRounds })

      const res = await client.files.form.post({ body: profileForm() })

      expect(res.status).toBe(200)
      expect(uploads).toHaveLength(3)
      expect(uploads[1]!.parts).toEqual(uploads[0]!.parts)
      expect(uploads[2]!.parts).toEqual(uploads[0]!.parts)
      expect(uploads[0]!.parts).toEqual([
        { field: 'caption', value: 'Rex at the café' },
        expect.objectContaining({ field: 'photos', name: 'crème brûlée.png', type: 'image/png' }),
        expect.objectContaining({ field: 'photos', name: 'adoption.pdf', type: 'application/pdf' }),
      ])
    })
  })

  describe('given a body of each kind', () => {
    // A follow-up is the same write again: other bytes or another type would store something the caller never sent.
    it.each(bodies)('should send %s whole, under its own type, on each of two follow-ups', async (_kind, body) => {
      const client = connect({ headers: expired, authenticator: twoRounds })

      const res = await client.files.raw.post({ body: body() })

      expect(res.status).toBe(200)
      expect(uploads.map(upload => upload.authorization)).toEqual(['Bearer expired', 'Bearer still-expired', ACCESS])
      expect(new Set(uploads.map(upload => `${upload.type} ${upload.size} ${upload.sha256}`)).size).toBe(1)
      expect(uploads[0]!.size).toBeGreaterThan(0)
    })
  })

  describe('given a large file from disk', () => {
    // A file-backed Blob is read from disk again for the follow-up, not held in memory for it.
    it('should send all of it again, byte for byte', async () => {
      const client = connect({ headers: expired, authenticator: oneRound })
      const video = await openAsBlob(join(dir, 'video.bin'), { type: 'video/mp4' })

      const res = await client.files.raw.post({ body: video })

      expect(res.status).toBe(200)
      expect(uploads.map(upload => [upload.type, upload.size, upload.sha256])).toEqual([
        ['video/mp4', LARGE, sha256(large)],
        ['video/mp4', LARGE, sha256(large)],
      ])
    })
  })

  describe('given a stream a function opens, counted as it goes', () => {
    // Each send reads the file anew, so the progress bar starts over for the follow-up rather than freezing at full.
    it('should open it once per send, and count each send from the start', async () => {
      const client = connect({ headers: expired, authenticator: oneRound })
      const file = new Blob([large.subarray(0, 256 * 1024)])
      const counted: number[] = []
      let opens = 0

      const res = await client.files.raw.post({
        body: () => {
          opens++
          return file.stream().pipeThrough(client.$progress(loaded => counted.push(loaded)))
        },
      })

      expect(res.status).toBe(200)
      expect(opens).toBe(2)
      // Each send counted up to the file's size and no further: the follow-up started from nothing.
      expect(counted.filter(loaded => loaded === file.size)).toHaveLength(2)
      expect(Math.max(...counted)).toBe(file.size)
      expect(uploads.map(upload => upload.size)).toEqual([file.size, file.size])
    })
  })

  describe('given a file that cannot be read again', () => {
    // A file deleted between the two sends fails the call: it must not go out as an empty upload under its name.
    it('should reject when the function throws for the follow-up, and store nothing more', async () => {
      const client = connect({ headers: expired, authenticator: oneRound })
      let opens = 0

      const failure = await client.files.raw
        .post({
          body: () => {
            if (++opens === 2) {
              throw new Error('the file is gone')
            }
            return new Blob(['first upload']).stream()
          },
        })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect(String((failure as Error).message) + String((failure as Error).cause)).toContain('the file is gone')
      expect(uploads.map(upload => upload.size)).toEqual(['first upload'.length])
    })

    // A function must open a new stream every time: handing back one already read fails loudly, never empty.
    it('should reject the follow-up when the function hands back the stream it already read', async () => {
      const client = connect({ headers: expired, authenticator: oneRound })
      const once = new Blob(['first upload']).stream()

      await expect(client.files.raw.post({ body: () => once })).rejects.toThrow(TypeError)
      expect(uploads.map(upload => upload.size)).toEqual(['first upload'.length])
    })
  })

  describe('given a live stream passed as it is', () => {
    function live(): ReadableStream<Uint8Array> {
      return new Blob(['a live recording']).stream()
    }

    // The stream was read as it was sent: the authenticator still refreshes for the calls that follow, and the call
    // says why it could not be resent and how to make it resendable.
    it('should ask, then reject with ErrBrewFollowUpNotSent naming the function form, and serve the next call', async () => {
      const tokens = new Tokens('expired', async () => 'fresh')
      const asked: Array<{ method: string; body: boolean }> = []
      const client = connect({
        headers: tokens.headers,
        authenticator: (request, response, attempt) => {
          asked.push({ method: request.method, body: request.body !== null })
          return tokens.authenticator(request, response, attempt)
        },
      })

      const failure = await client.files.raw.post({ body: live() }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(ErrBrewFollowUpNotSent)
      expect((failure as Error).message).toContain('its body is a stream, read as it was sent')
      expect((failure as Error).message).toContain('{ body: () => stream }')
      expect(asked).toEqual([{ method: 'POST', body: false }])
      expect(uploads.map(upload => upload.authorization)).toEqual(['Bearer expired'])

      const next = await client.files.raw.post({ body: live })

      expect(next.status).toBe(200)
      expect(uploads.map(upload => upload.authorization)).toEqual(['Bearer expired', ACCESS])
    })

    // Giving up leaves the server's answer to the caller, as for any other body.
    it('should resolve with the 401 when the authenticator gives up', async () => {
      const client = connect({ headers: expired, authenticator: () => null })

      const res = await client.files.raw.post({ body: live() })

      expect(res.status).toBe(401)
    })
  })
})

describe('brewer uploading under an expiring token over a socket', () => {
  const connect: Connect = options => brewer<typeof app>(origin, options)

  // A gateway that checks the token first answers before reading the upload: the follow-up must still deliver it all.
  it('should deliver all 8 MiB on the follow-up when the server refused the token before reading any', async () => {
    const client = connect({ headers: expired, authenticator: oneRound })

    const res = await client.files.early.put({ body: () => new Blob([large]).stream() })

    expect(res.status).toBe(200)
    expect(uploads.map(upload => [upload.authorization, upload.size, upload.sha256])).toEqual([
      ['Bearer expired', 0, null],
      [ACCESS, LARGE, sha256(large)],
    ])
  })

  // An upload the caller abandons must release its source, a file handle or a socket, rather than hold it open.
  it('should cancel the stream a function opened when the call aborts part-way', async () => {
    const client = connect({ headers: { authorization: ACCESS }, authenticator: oneRound })
    const controller = new AbortController()
    const received = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    reading = received.resolve
    let sent = false

    try {
      const call = client.files.held.put({
        signal: controller.signal,
        body: () =>
          new ReadableStream<Uint8Array>({
            pull(stream) {
              if (!sent) {
                sent = true
                stream.enqueue(new Uint8Array(1024))
              }
              // Nothing more until the caller gives up.
              return new Promise<void>(() => undefined)
            },
            cancel: () => released.resolve(),
          }),
      })
      await received.promise
      controller.abort()

      await expect(call).rejects.toMatchObject({ name: 'AbortError' })
      await released.promise
    } finally {
      reading = undefined
    }
  })
})
