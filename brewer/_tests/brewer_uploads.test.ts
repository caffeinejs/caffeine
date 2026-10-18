import { createHash, randomFillSync } from 'node:crypto'
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Router, bodyAsStream } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { multipart, multipartPlugin } from '@caffeinejs/multipart'
import { $t } from '@caffeinejs/std/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * Uploads as the server receives them: a form built by `$formData`, files of every size and name, and a body streamed
 * while it is counted, or stopped part-way.
 *
 * Every route answers with what reached it, a file by its SHA-256, so each test asserts on what the server read
 * rather than on what the client meant to send.
 */

type Part =
  | { field: string; value: string }
  | { field: string; name: string; type: string; size: number; sha256: string }

const LARGE = 8 * 1024 * 1024

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function partsOf(form: FormData): Promise<Part[]> {
  const parts: Part[] = []

  for (const [field, value] of form) {
    if (typeof value === 'string') {
      parts.push({ field, value })
    } else {
      const bytes = await value.bytes()
      parts.push({ field, name: value.name, type: value.type, size: bytes.byteLength, sha256: sha256(bytes) })
    }
  }

  return parts
}

// The upload the stopped-part-way route is reading: told when its first chunk arrived, and when the rest broke off.
let reading: { received: () => void; broken: () => void } | undefined

const uploads = new Router('/uploads')
  .post('/profile')
  .schema({ body: $t.Object({ caption: $t.String(), avatar: $t.File(), photos: $t.Optional($t.Files()) }) })
  .handler(async ctx => ({ parts: await partsOf(await multipart(ctx).formData()) }))
  .post('/files')
  .handler(async ctx => ({ parts: await partsOf(await multipart(ctx).formData()) }))
  .post('/raw')
  .extend(bodyAsStream())
  .bodyLimit(2 * LARGE)
  .handler(async ctx => {
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of ctx.req.body() as ReadableStream<Uint8Array>) {
      hash.update(chunk)
      size += chunk.byteLength
    }

    return { type: ctx.req.header('content-type') ?? null, size, sha256: hash.digest('hex') }
  })
  .post('/held')
  .extend(bodyAsStream())
  .handler(async ctx => {
    const reader = (ctx.req.body() as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    reading?.received()
    try {
      while (!(await reader.read()).done) {
        // Read on until the upload ends, or breaks off.
      }
      return { completed: true }
    } catch {
      reading?.broken()
      return { completed: false }
    }
  })

// An upload stopped part-way can leave the server a connection with no request on it, which its graceful close
// would otherwise wait out (caffeinejs/caffeine#131): a connection quiet for a second is dropped.
const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .with(() => multipartPlugin({ limits: { fileSize: 2 * LARGE } }))
  .mount(uploads)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

const fileNamed = (bytes: Uint8Array<ArrayBuffer> | string, name: string, type = '') =>
  new File([bytes], name, { type })

describe.each([
  ['in process', () => brewer(app)],
  ['over a socket', () => brewer<typeof app>(origin)],
] as const)('brewer uploading files, %s', (_transport, connect) => {
  it('should send a form built with $formData, each part as the route declares it', async () => {
    const avatar = fileNamed(new Uint8Array([255, 216, 255]), 'rex.jpg', 'image/jpeg')
    const beach = fileNamed('beach', 'beach.png', 'image/png')
    const park = fileNamed('park', 'park.png', 'image/png')

    const client = connect()

    const res = await client.uploads.profile.post({
      body: client.$formData({ caption: 'Rex at the beach', avatar, photos: [beach, park] }),
    })

    expect(await res.json()).toEqual({
      parts: [
        { field: 'caption', value: 'Rex at the beach' },
        {
          field: 'avatar',
          name: 'rex.jpg',
          type: 'image/jpeg',
          size: 3,
          sha256: sha256(new Uint8Array([255, 216, 255])),
        },
        {
          field: 'photos',
          name: 'beach.png',
          type: 'image/png',
          size: 5,
          sha256: sha256(new TextEncoder().encode('beach')),
        },
        {
          field: 'photos',
          name: 'park.png',
          type: 'image/png',
          size: 4,
          sha256: sha256(new TextEncoder().encode('park')),
        },
      ],
    })
  })

  it('should keep a file name in UTF-8, spaces and all', async () => {
    const client = connect()

    const res = await client.uploads.files.post({
      body: client.$formData({ file: fileNamed('x', 'résumé 2026 😀.pdf') }),
    })

    expect(await res.json()).toMatchObject({ parts: [{ name: 'résumé 2026 😀.pdf' }] })
  })

  it('should send an empty file as a part with a name and no bytes', async () => {
    const client = connect()

    const res = await client.uploads.files.post({
      body: client.$formData({ file: fileNamed('', 'empty.txt', 'text/plain') }),
    })

    expect(await res.json()).toMatchObject({ parts: [{ name: 'empty.txt', type: 'text/plain', size: 0 }] })
  })

  it('should send many files under one field, every one in order', async () => {
    const files = Array.from({ length: 25 }, (_, i) => fileNamed(`page ${i}`, `page-${i}.txt`, 'text/plain'))

    const client = connect()

    const res = await client.uploads.files.post({ body: client.$formData({ pages: files }) })

    const { parts } = (await res.json()) as { parts: Array<{ name: string }> }
    expect(parts.map(part => part.name)).toEqual(files.map(file => file.name))
  })

  // FormData names a Blob that carries no name of its own "blob", which is what the server then sees.
  it('should send a Blob with no name as a file named blob', async () => {
    const form = new FormData()
    form.append('file', new Blob(['data'], { type: 'application/octet-stream' }))

    const res = await connect().uploads.files.post({ body: form })

    expect(await res.json()).toMatchObject({ parts: [{ name: 'blob', type: 'application/octet-stream', size: 4 }] })
  })
})

// Read from disk, as a file a user picks is: the platform then streams it in chunks rather than in one piece.
describe('brewer uploading a large file over a socket', () => {
  const large = randomFillSync(new Uint8Array(LARGE))
  const dir = mkdtempSync(join(tmpdir(), 'brewer-uploads-'))
  let file: File

  beforeAll(async () => {
    writeFileSync(join(dir, 'backup.tar'), large)
    const type = 'application/x-tar'
    file = new File([await openAsBlob(join(dir, 'backup.tar'), { type })], 'backup.tar', { type })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should deliver every byte of a multipart upload, as the server hashes it', async () => {
    const client = brewer<typeof app>(origin)

    const res = await client.uploads.files.post({ body: client.$formData({ backup: file }) })

    expect(await res.json()).toEqual({
      parts: [{ field: 'backup', name: 'backup.tar', type: 'application/x-tar', size: LARGE, sha256: sha256(large) }],
    })
  })

  it('should count a streamed upload as it is sent, and deliver every byte of it', async () => {
    const client = brewer<typeof app>(origin)
    const reported: number[] = []

    const res = await client.uploads.raw.post({
      body: file.stream().pipeThrough(client.$progress(loaded => reported.push(loaded))),
      headers: { 'content-type': file.type },
    })

    expect(await res.json()).toEqual({ type: 'application/x-tar', size: LARGE, sha256: sha256(large) })
    expect(reported.length).toBeGreaterThan(1)
    expect(reported.at(-1)).toBe(file.size)
    expect(reported).toEqual([...reported].sort((a, b) => a - b))
  })
})

describe('brewer stopping an upload part-way over a socket', () => {
  it('should reject the call when it aborts, and the server see the upload break off', async () => {
    const client = brewer<typeof app>(origin)
    const controller = new AbortController()
    const received = Promise.withResolvers<void>()
    const broken = Promise.withResolvers<void>()
    const never = Promise.withResolvers<void>()
    reading = { received: received.resolve, broken: broken.resolve }
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        pulls++
        if (pulls === 1) {
          stream.enqueue(new Uint8Array(1024).fill(1))
        } else {
          await never.promise
        }
      },
    })

    try {
      const pending = client.uploads.held.post({
        body,
        signal: controller.signal,
        headers: { 'content-type': 'application/octet-stream' },
      })
      await received.promise
      controller.abort()

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await broken.promise
    } finally {
      never.resolve()
      reading = undefined
    }
  })
})
