import { createHash } from 'node:crypto'
import { openAsBlob, readFileSync } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect as connectH2 } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import fastifyCompress from '@fastify/compress'
import { type FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Attachment, Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import { expectPatternedBody, expectRangeAnswer } from './bodies.js'
import { fillPatterned, firstMismatch, patterned } from './patterned.js'

/**
 * Downloads at the sizes real ones come in, over a real socket: an application's own `fetch` reads a whole response
 * before it answers, so streaming, aborting and resuming are only visible here.
 *
 * Every body is the offset pattern, so each byte received is checked against where it claims to sit, and a whole
 * body against the SHA-256 of what was served.
 */

const KiB = 1024
const MiB = 1024 * KiB
const FILE_SIZE = 64 * MiB
const FILE_ETAG = '"big-v1"'
const GiB = 1024 * MiB
// Node's Blob takes slice offsets of 32 bits: past them it aborts the process. A Blob up to 2^32 - 1 bytes is the
// largest that can be served in ranges; anything larger is sent whole.
const LARGEST_RANGED = 2 ** 32 - 1
// Five sparse gigabytes, so offsets past 32 bits are announced and checked at neither a disk's nor a memory's cost.
// Assembled from parts: `fs.openAsBlob` reports the size of a single file past 4 GiB modulo 2^32 (Node 22 and 24).
const HUGE_SIZE = 5 * GiB
const WINDOW = 64 * KiB

// One buffer for the in-memory routes: a view into the middle of it is what goes out, or a copy of its start.
const HOLDER = patterned(0, 40 * MiB)
const ARRAY_BUFFER = HOLDER.slice(0, 32 * MiB).buffer

let dir: string
let filePath: string
let fileDigest: string
let huge: Blob[] = []
let edge: Blob[] = []
let sparse = false
// What a resumed download is served instead of the file, once the test has replaced the content.
let replacement: { blob: Blob; etag: string } | undefined

function sha256(...parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
  }

  return hash.digest('hex')
}

/** A web stream of `size` bytes of the pattern, made a megabyte at a time as it is read and never held whole. */
function generated(size: number): ReadableStream<Uint8Array> {
  let offset = 0

  return new ReadableStream({
    pull(controller) {
      if (offset >= size) {
        controller.close()
        return
      }

      const chunk = patterned(offset, Math.min(MiB, size - offset))
      offset += chunk.length
      controller.enqueue(chunk)
    },
  })
}

const bigFile = async () => Attachment(await openAsBlob(filePath), { name: 'big.bin', etag: FILE_ETAG })

const routes = new Router('/big')
routes.get('/file').handler(bigFile)
routes.get('/file-plain').handler(async () => openAsBlob(filePath))
routes.get('/huge').handler(() => Attachment(new Blob(huge), { name: 'disk.img', etag: '"disk-v1"' }))
routes.get('/huge-plain').handler(() => new Blob(huge))
routes.get('/edge').handler(() => Attachment(new Blob(edge), { name: 'edge.img', etag: '"edge-v1"' }))
routes
  .get('/versioned')
  .handler(async () =>
    replacement === undefined
      ? Attachment(await openAsBlob(filePath), { name: 'report.bin', etag: FILE_ETAG })
      : Attachment(replacement.blob, { name: 'report.bin', etag: replacement.etag }),
  )
routes.get('/view').handler(() => HOLDER.subarray(4 * MiB, 36 * MiB))
routes.get('/array-buffer').handler(() => ARRAY_BUFFER)
routes.get('/stream').handler(() => generated(FILE_SIZE))

// A client that stops a download part-way can leave the server a connection with no request on it, which its
// graceful close would otherwise wait out (caffeinejs/caffeine#131): every connection is closed as the server closes.
const app = createWebApplication()
  .server(() => ({ factory: { forceCloseConnections: true }, listener: { host: '127.0.0.1', port: 0 } }))
  .mount(routes)

let origin: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-downloads-'))

  // The 64 MiB file, written a megabyte at a time and hashed as it is written.
  filePath = join(dir, 'big.bin')
  const file = await open(filePath, 'w')
  const hash = createHash('sha256')
  const chunk = new Uint8Array(MiB)
  for (let offset = 0; offset < FILE_SIZE; offset += MiB) {
    fillPatterned(chunk, offset)
    hash.update(chunk)
    await file.write(chunk, 0, MiB, offset)
  }
  await file.close()
  fileDigest = hash.digest('hex')

  // Sparse parts: holes, with the pattern laid down only where the tests read. Five 1 GiB parts make the 5 GiB
  // Blob; three of them and one a byte short of a gigabyte make the largest Blob that ranges are served from.
  const windows = [0, 2 ** 32 - WINDOW / 2, LARGEST_RANGED - WINDOW, HUGE_SIZE - WINDOW]
  const part = async (name: string, base: number, size: number): Promise<Blob> => {
    const path = join(dir, name)
    const handle = await open(path, 'w')
    await handle.truncate(size)
    for (const at of windows) {
      const from = Math.max(at, base)
      const to = Math.min(at + WINDOW, base + size)
      if (from < to) {
        await handle.write(patterned(from, to - from), 0, to - from, from - base)
      }
    }
    await handle.close()

    return openAsBlob(path)
  }

  huge = await Promise.all(Array.from({ length: 5 }, (_, k) => part(`huge-${k}.img`, k * GiB, GiB)))
  edge = [...huge.slice(0, 3), await part('edge-3.img', 3 * GiB, GiB - 1)]

  const { blocks } = await stat(join(dir, 'huge-4.img'))
  sparse = blocks * 512 < 16 * MiB

  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

/** Reads `res` to its end, hashing as it goes: a large body is never held. */
async function digestOf(res: Response, ...before: Uint8Array[]): Promise<{ digest: string; length: number }> {
  const hash = createHash('sha256')
  let length = 0
  for (const part of before) {
    hash.update(part)
    length += part.length
  }
  for await (const chunk of res.body!) {
    hash.update(chunk)
    length += chunk.length
  }

  return { digest: hash.digest('hex'), length }
}

/** The first `n` bytes of a download, read as they arrive, after which the client hangs up. */
async function readThenAbort(path: string, n: number, headers: Record<string, string> = {}): Promise<Uint8Array> {
  const controller = new AbortController()
  const res = await fetch(`${origin}${path}`, { headers, signal: controller.signal })
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  while (received < n) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    chunks.push(value)
    received += value.length
  }

  controller.abort()
  await reader.cancel().catch(() => undefined)

  return Buffer.concat(chunks).subarray(0, n)
}

describe('a large download over a socket', { timeout: 60_000 }, () => {
  it('sends a 64 MiB file-backed Blob whole, with the exact length, and every byte the file holds', async () => {
    const res = await fetch(`${origin}/big/file-plain`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(FILE_SIZE))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(await digestOf(res)).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })

  it('sends a 64 MiB Attachment whole, named, with the exact length and every byte', async () => {
    const res = await fetch(`${origin}/big/file`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(FILE_SIZE))
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="big.bin"; filename*=UTF-8''big.bin`)
    expect(await digestOf(res)).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })

  it('sends 32 MiB of bytes viewed out of a larger buffer, exactly the view', async () => {
    const res = await fetch(`${origin}/big/view`)

    expect(res.headers.get('content-length')).toBe(String(32 * MiB))
    await expectPatternedBody(res, 4 * MiB, 32 * MiB)
  })

  it('sends a 32 MiB ArrayBuffer as its bytes', async () => {
    const res = await fetch(`${origin}/big/array-buffer`)

    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBe(String(32 * MiB))
    expect(await digestOf(res)).toEqual({ digest: sha256(new Uint8Array(ARRAY_BUFFER)), length: 32 * MiB })
  })

  it('streams a 64 MiB body of unknown length, chunked, labelled as bytes', async () => {
    const res = await fetch(`${origin}/big/stream`)

    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBe('chunked')
    expect(await digestOf(res)).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })

  it('keeps serving after clients hang up part-way through large downloads', async () => {
    const cut = await Promise.all(Array.from({ length: 10 }, () => readThenAbort('/big/file', MiB)))
    for (const prefix of cut) {
      expect(firstMismatch(prefix, 0)).toBe(-1)
    }

    expect(await digestOf(await fetch(`${origin}/big/file`))).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })
})

describe('a large download resumed and read in parts', { timeout: 60_000 }, () => {
  it.each([1, 65_535, 33 * MiB + 7])('resumes a download cut off after %i bytes into exactly the file', async cutAt => {
    const prefix = await readThenAbort('/big/file', cutAt)
    expect(prefix.length).toBe(cutAt)

    const rest = await fetch(`${origin}/big/file`, { headers: { range: `bytes=${cutAt}-`, 'if-range': FILE_ETAG } })

    expect(rest.status).toBe(206)
    expect(rest.headers.get('content-range')).toBe(`bytes ${cutAt}-${FILE_SIZE - 1}/${FILE_SIZE}`)
    expect(rest.headers.get('content-length')).toBe(String(FILE_SIZE - cutAt))
    expect(await digestOf(rest, prefix)).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })

  it('sends the new content whole when it changed between attempts, rather than splicing two versions', async () => {
    const prefix = await readThenAbort('/big/versioned', 3 * MiB)
    const next = patterned(3, 16 * MiB)
    replacement = { blob: new Blob([next]), etag: '"report-v2"' }

    try {
      const res = await fetch(`${origin}/big/versioned`, {
        headers: { range: `bytes=${prefix.length}-`, 'if-range': FILE_ETAG },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('etag')).toBe('"report-v2"')
      expect(await digestOf(res)).toEqual({ digest: sha256(next), length: next.length })
    } finally {
      replacement = undefined
    }
  })

  it('reassembles the file from 8 ranges downloaded at once', async () => {
    const segment = FILE_SIZE / 8
    const parts = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const start = i * segment
        const res = await fetch(`${origin}/big/file`, {
          headers: { range: `bytes=${start}-${start + segment - 1}`, 'if-range': FILE_ETAG },
        })

        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe(`bytes ${start}-${start + segment - 1}/${FILE_SIZE}`)
        return expectPatternedBody(res, start, segment)
      }),
    )

    expect(sha256(...parts)).toBe(fileDigest)
  })

  it('serves pieces spread across the file in one answer: its first byte, a span across a megabyte, its last byte', async () => {
    const res = await fetch(`${origin}/big/file`, {
      headers: { range: `bytes=0-0,${MiB - 6}-${MiB + 9},${FILE_SIZE - 1}-${FILE_SIZE - 1}`, 'if-range': FILE_ETAG },
    })

    await expectRangeAnswer(
      res,
      {
        status: 206,
        parts: [
          [0, 0],
          [MiB - 6, MiB + 9],
          [FILE_SIZE - 1, FILE_SIZE - 1],
        ],
      },
      FILE_SIZE,
    )
  })

  it('serves two 8 MiB pieces of the file in one answer, every byte where its part says', async () => {
    const tail = FILE_SIZE - 8 * MiB
    const res = await fetch(`${origin}/big/file`, { headers: { range: `bytes=0-${8 * MiB - 1},${tail}-` } })

    await expectRangeAnswer(
      res,
      {
        status: 206,
        parts: [
          [0, 8 * MiB - 1],
          [tail, FILE_SIZE - 1],
        ],
      },
      FILE_SIZE,
    )
  })

  it('serves a media player seeking: the start, a jump to the middle, then the trailing index', async () => {
    const start = await readThenAbort('/big/file', MiB, { range: 'bytes=0-' })
    expect(firstMismatch(start, 0)).toBe(-1)

    const middle = FILE_SIZE / 2 + 12_345
    const jump = await readThenAbort('/big/file', MiB, { range: `bytes=${middle}-` })
    expect(jump.length).toBe(MiB)
    expect(firstMismatch(jump, middle)).toBe(-1)

    const tail = await fetch(`${origin}/big/file`, { headers: { range: 'bytes=-1024' } })
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe(`bytes ${FILE_SIZE - 1024}-${FILE_SIZE - 1}/${FILE_SIZE}`)
    await expectPatternedBody(tail, FILE_SIZE - 1024, 1024)
  })
})

describe('a download at and past the 32-bit limit', { timeout: 60_000 }, () => {
  const unsparse = 'this filesystem cannot make sparse files, and the parts would be written out in full'

  it('announces the whole length of a 5 GiB Blob, beyond what 32 bits hold', async ({ skip }) => {
    skip(!sparse, unsparse)

    for (const path of ['/big/huge', '/big/huge-plain']) {
      const res = await fetch(`${origin}${path}`, { method: 'HEAD' })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe(String(HUGE_SIZE))
    }
  })

  it('streams a 5 GiB Blob from its first byte', async ({ skip }) => {
    skip(!sparse, unsparse)

    const start = await readThenAbort('/big/huge-plain', WINDOW)

    expect(start.length).toBe(WINDOW)
    expect(firstMismatch(start, 0)).toBe(-1)
  })

  it('answers a range of a Blob past 4 GiB with the whole body, and the process lives on to serve the next request', async ({
    skip,
  }) => {
    skip(!sparse, unsparse)

    // Ranges are not offered, since the part could not be cut out of it.
    const head = await fetch(`${origin}/big/huge`, { method: 'HEAD' })
    expect(head.headers.get('accept-ranges')).toBeNull()

    for (const range of ['bytes=0-', `bytes=${2 ** 32 - 6}-${2 ** 32 + 9}`, 'bytes=-16', 'bytes=0-9,100-109']) {
      const controller = new AbortController()
      const res = await fetch(`${origin}/big/huge`, { headers: { range }, signal: controller.signal })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-range')).toBeNull()
      controller.abort()
    }

    expect((await fetch(`${origin}/big/edge`, { method: 'HEAD' })).status).toBe(200)
  })

  it('serves ranges of a Blob of 2^32 - 1 bytes, the largest that can be cut, up to its very last byte', async ({
    skip,
  }) => {
    skip(!sparse, unsparse)

    const head = await fetch(`${origin}/big/edge`, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe(String(LARGEST_RANGED))
    expect(head.headers.get('accept-ranges')).toBe('bytes')

    for (const range of ['bytes=-16', `bytes=${LARGEST_RANGED - 100}-`, `bytes=${LARGEST_RANGED - 64}-${2 ** 40}`]) {
      const res = await fetch(`${origin}/big/edge`, { headers: { range } })
      const body = new Uint8Array(await res.arrayBuffer())
      const first = LARGEST_RANGED - body.length

      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes ${first}-${LARGEST_RANGED - 1}/${LARGEST_RANGED}`)
      expect(firstMismatch(body, first)).toBe(-1)
    }
  })

  it('serves several ranges of that Blob together, at offsets past 31 bits and up to its very last byte', async ({
    skip,
  }) => {
    skip(!sparse, unsparse)

    const parts = [
      [0, 99],
      [2 ** 32 - 1000, 2 ** 32 - 901],
      [LARGEST_RANGED - 1, LARGEST_RANGED - 1],
    ] as const
    const res = await fetch(`${origin}/big/edge`, {
      headers: { range: `bytes=${parts.map(([start, end]) => `${start}-${end}`).join(',')}` },
    })

    await expectRangeAnswer(res, { status: 206, parts }, LARGEST_RANGED)
  })
})

/** A CSV export of about `size` bytes: text a compressor shrinks, unlike the pattern. */
function csv(size: number): Uint8Array<ArrayBuffer> {
  const lines: string[] = ['region,order,total\n']
  let length = lines[0].length
  for (let i = 0; length < size; i++) {
    const line = `region-${i % 17},${i},${(i * 7919) % 100_000}\n`
    lines.push(line)
    length += line.length
  }

  return new TextEncoder().encode(lines.join(''))
}

describe('a large CSV export behind a compressor', { timeout: 60_000 }, () => {
  const compress: FastifyPluginAsync = async instance => {
    await instance.register(fastifyCompress)
  }

  // Built here, so a run that filters this suite out does not pay for 32 MiB of text.
  let csvBytes: Uint8Array<ArrayBuffer>
  let report: Blob

  const compressing = createWebApplication()
    .server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
    .with(() => fp(compress, { name: 'compress' }))
    .mount(new Router('/export').get('/q3').handler(() => report))

  beforeAll(async () => {
    csvBytes = csv(32 * MiB)
    report = new Blob([csvBytes], { type: 'text/csv' })
    await compressing.run()
  })

  afterAll(async () => {
    await compressing.close()
  })

  /** The raw bytes and headers as they cross the wire: `fetch` would decompress them out of sight. */
  function raw(headers: Record<string, string>): Promise<{ headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${compressing.address!.origin}/export/q3`, { headers }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('compresses it for a client that accepts gzip, never claiming the uncompressed length', async () => {
    const { headers, body } = await raw({ 'accept-encoding': 'gzip' })

    expect(headers['content-encoding']).toBe('gzip')
    if (headers['content-length'] !== undefined) {
      expect(Number(headers['content-length'])).toBe(body.length)
    }
    expect(body.length).toBeLessThan(csvBytes.length / 2)
    expect(gunzipSync(body).equals(csvBytes)).toBe(true)
  })

  it('sends it as it is to a client that accepts no encoding, with its exact length', async () => {
    const { headers, body } = await raw({ 'accept-encoding': 'identity' })

    expect(headers['content-encoding']).toBeUndefined()
    expect(headers['content-length']).toBe(String(csvBytes.length))
    expect(body.equals(csvBytes)).toBe(true)
  })
})

describe('a large download over HTTP/2', { timeout: 60_000 }, () => {
  const key = readFileSync(new URL('./_testdata/tls/localhost.key', import.meta.url))
  const cert = readFileSync(new URL('./_testdata/tls/localhost.crt', import.meta.url))

  const secure = createWebApplication()
    .server(() => ({ factory: { http2: true, https: { key, cert } }, listener: { host: '127.0.0.1', port: 0 } }))
    .mount(new Router('/h2').get('/file').handler(bigFile))

  beforeAll(async () => {
    await secure.run()
  })

  afterAll(async () => {
    await secure.close()
  })

  function get(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; digest: string; length: number }>(
      (resolve, reject) => {
        const session = connectH2(secure.address!.origin, { ca: cert })
        session.on('error', reject)

        const stream = session.request({ ':path': path, ...headers })
        const hash = createHash('sha256')
        let length = 0
        let head: Record<string, unknown> = {}
        stream.on('response', h => (head = h))
        stream.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          length += chunk.length
        })
        stream.on('end', () => {
          session.close()
          resolve({ status: Number(head[':status']), headers: head, digest: hash.digest('hex'), length })
        })
        stream.on('error', reject)
        stream.end()
      },
    )
  }

  it('sends a 64 MiB Attachment whole, with the exact length and every byte', async () => {
    const res = await get('/h2/file')

    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe(String(FILE_SIZE))
    expect({ digest: res.digest, length: res.length }).toEqual({ digest: fileDigest, length: FILE_SIZE })
  })

  it('serves a range of it', async () => {
    const half = FILE_SIZE / 2
    const res = await get('/h2/file', { range: `bytes=${half}-`, 'if-range': FILE_ETAG })

    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes ${half}-${FILE_SIZE - 1}/${FILE_SIZE}`)
    expect(res.length).toBe(half)
  })
})
