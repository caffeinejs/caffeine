import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Attachment, Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { download, staticFiles } from '@caffeinejs/static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * Downloads read the way the platform reads any response: whole, as a `File`, in ranges, or as a stream that arrives
 * chunk by chunk and can be stopped part-way.
 *
 * The file is served from disk by `@caffeinejs/static`, so its range, validator and naming headers are the ones a
 * real file server writes. Streams are tested over a socket: an application's own `fetch` reads a whole response
 * before it answers.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewer-downloads-'))
const report = Uint8Array.from({ length: 4096 }, (_, i) => i % 251)
writeFileSync(join(dir, 'report.pdf'), report)

/** A body the test writes chunk by chunk, told when the client stops reading it. */
interface Feed {
  write(chunk: Uint8Array | string): void
  end(): void
  readonly cancelled: Promise<void>
}

// The body the streaming routes answer with, written by the test in progress.
let feeding: ReadableStream<Uint8Array> | undefined

function feed(): Feed {
  const cancelled = Promise.withResolvers<void>()
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>

  feeding = new ReadableStream<Uint8Array>({
    start: c => {
      controller = c
    },
    cancel: () => cancelled.resolve(),
  })

  return {
    write: chunk => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk),
    end: () => controller.close(),
    cancelled: cancelled.promise,
  }
}

const LARGE = 4 * 1024 * 1024
const CHUNK = 64 * 1024

// Bytes no two positions of a chunk share with the start of the next, so a byte out of place shows.
const byteAt = (offset: number) => offset % 251

/** A large body made as it is read, never held whole. */
function large(): ReadableStream<Uint8Array> {
  let offset = 0

  return new ReadableStream<Uint8Array>({
    pull: controller => {
      if (offset >= LARGE) {
        controller.close()
        return
      }

      const start = offset
      controller.enqueue(Uint8Array.from({ length: CHUNK }, (_, i) => byteAt(start + i)))
      offset += CHUNK
    },
  })
}

// What a route builds in memory rather than reads from disk: an export, a generated report.
const GENERATED = new Date('2026-10-01T12:34:56.789Z')
const GENERATED_ETAG = '"report-v1"'
const ARCHIVE = 64 * 1024 * 1024

/** A large Blob of the same bytes as `large()`, assembled from views of one buffer rather than byte by byte. */
function archive(): Blob {
  const period = new Uint8Array(CHUNK + 251).map((_, i) => byteAt(i))
  const parts = Array.from({ length: ARCHIVE / CHUNK }, (_, i) =>
    period.subarray((i * CHUNK) % 251, ((i * CHUNK) % 251) + CHUNK),
  )

  return new Blob(parts)
}

function bundle(): FormData {
  const form = new FormData()
  form.append('title', 'Q3 reports')
  form.append('files', new File(['region,total\nnorth,12\n'], 'north.csv', { type: 'text/csv' }))
  form.append('files', new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' }))

  return form
}

const downloads = new Router('/downloads')
  .get('/report')
  .handler(ctx => download(ctx, 'report.pdf', 'résumé 2026.pdf', { root: dir }))
  .get('/feed')
  .handler(() => new Response(feeding, { headers: { 'content-type': 'application/octet-stream' } }))
  .get('/events')
  .handler(
    () => new Response(feeding, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }),
  )
  .get('/lines')
  .handler(() => new Response(feeding, { headers: { 'content-type': 'application/x-ndjson' } }))
  .get('/large')
  .handler(
    () =>
      new Response(large(), {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(LARGE) },
      }),
  )
  .get('/bundle')
  .handler(() => new Response(bundle()))
  .get('/generated')
  .handler(() =>
    Attachment(new Blob([report], { type: 'application/pdf' }), {
      name: 'résumé 2026.pdf',
      etag: GENERATED_ETAG,
      lastModified: GENERATED,
    }),
  )
  .get('/hostile')
  .handler(() => Attachment(new Blob([report]), { name: '../../etc/passwd' }))
  .get('/archive')
  .handler(() => Attachment(archive(), { name: 'archive.bin' }))

// A client that stops a download part-way can leave the server a connection with no request on it, which its
// graceful close would otherwise wait out (caffeinejs/caffeine#131): a connection quiet for a second is dropped.
const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .with(staticFiles(s => s.serve(dir, { prefix: '/files' })))
  .mount(downloads)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Every byte a stream holds, read chunk by chunk as a file written to disk would be. */
async function drain(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Uint8Array> {
  const chunks = await Array.fromAsync(stream)

  return new Uint8Array(await new Blob(chunks).arrayBuffer())
}

describe.each([
  ['in process', () => brewer(app)],
  ['over a socket', () => brewer<typeof app>(origin)],
] as const)('brewer downloading a file, %s', (_transport, connect) => {
  it.each([
    ['blob()', (res: Response) => res.blob().then(blob => blob.bytes())],
    ['bytes()', (res: Response) => res.bytes()],
    ['arrayBuffer()', (res: Response) => res.arrayBuffer().then(buffer => new Uint8Array(buffer))],
    ['the body stream', (res: Response) => drain(res.body!)],
  ])('should hand back every byte through %s', async (_reader, read) => {
    const res = await connect().downloads.report.get()

    expect(res.status).toBe(200)
    expect(await read(res as Response)).toEqual(report)
  })

  it('should read it into a File named, typed and dated by the server, the UTF-8 name included', async () => {
    const client = connect()
    const res = await client.downloads.report.get()

    const file = await client.$file(res)

    expect(file.name).toBe('résumé 2026.pdf')
    expect(file.type).toBe('application/pdf')
    expect(file.lastModified).toBe(Math.floor(statSync(join(dir, 'report.pdf')).mtimeMs / 1000) * 1000)
    expect(await file.bytes()).toEqual(report)
  })

  it('should name it before reading a byte, so it can be streamed to disk under that name', async () => {
    const client = connect()
    const res = await client.downloads.report.get()

    const name = client.$filename(res)

    expect(res.bodyUsed).toBe(false)
    expect(name).toBe('résumé 2026.pdf')
    expect(await drain(res.body!)).toEqual(report)
  })

  describe('given a range', () => {
    it('should hand back only the bytes it asks for, saying which they are', async () => {
      const res = await connect().downloads.report.get({ headers: { range: 'bytes=0-99' } })

      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-99/4096')
      expect(await res.bytes()).toEqual(report.slice(0, 100))
    })

    // A download cut off part-way picks up where it stopped, rather than starting over.
    it('should resume from where an earlier download stopped, while the file is the same', async () => {
      const client = connect()
      const first = await client.downloads.report.get({ headers: { range: 'bytes=0-1023' } })
      const etag = first.headers.get('etag')!

      const rest = await client.downloads.report.get({ headers: { range: 'bytes=1024-', 'if-range': etag } })

      expect(rest.status).toBe(206)
      expect(await new Blob([await first.bytes(), await rest.bytes()]).bytes()).toEqual(report)
    })

    it('should hand back the whole file instead when it changed since the part already held', async () => {
      const res = await connect().downloads.report.get({ headers: { range: 'bytes=1024-', 'if-range': 'W/"stale"' } })

      expect(res.status).toBe(200)
      expect(await res.bytes()).toEqual(report)
    })

    it('should answer 416 for a range past the end, saying how long the file is', async () => {
      const res = await connect().downloads.report.get({ headers: { range: 'bytes=5000-' } })

      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */4096')
    })
  })

  it('should read a multipart answer with formData(), each file under its own name and type', async () => {
    const form = await (await connect().downloads.bundle.get()).formData()

    const files = form.getAll('files') as File[]

    expect(form.get('title')).toBe('Q3 reports')
    expect(files.map(file => [file.name, file.type])).toEqual([
      ['north.csv', 'text/csv'],
      ['chart.png', 'image/png'],
    ])
    expect(await files[0]!.text()).toBe('region,total\nnorth,12\n')
    expect(await files[1]!.bytes()).toEqual(new Uint8Array([137, 80, 78, 71]))
  })
})

describe.each([
  ['in process', () => brewer(app)],
  ['over a socket', () => brewer<typeof app>(origin)],
] as const)('brewer downloading what a route built in memory with Attachment(), %s', (_transport, connect) => {
  it('should read it into a File named, typed and dated by the server, the UTF-8 name included', async () => {
    const client = connect()
    const res = await client.downloads.generated.get()

    const file = await client.$file(res)

    expect(file.name).toBe('résumé 2026.pdf')
    expect(file.type).toBe('application/pdf')
    expect(file.lastModified).toBe(Math.floor(GENERATED.getTime() / 1000) * 1000)
    expect(await file.bytes()).toEqual(report)
  })

  it('should name it before reading a byte, so it can be streamed to disk under that name', async () => {
    const client = connect()
    const res = await client.downloads.generated.get()

    expect(client.$filename(res)).toBe('résumé 2026.pdf')
    expect(res.bodyUsed).toBe(false)
    expect(await drain(res.body!)).toEqual(report)
  })

  it('should save a name that climbs out of its directory as a plain file name', async () => {
    const client = connect()

    const file = await client.$file(await client.downloads.hostile.get())

    expect(file.name).toBe('passwd')
  })

  describe('given a range', () => {
    it('should hand back only the bytes it asks for, saying which they are', async () => {
      const res = await connect().downloads.generated.get({ headers: { range: 'bytes=0-99' } })

      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-99/4096')
      expect(await res.bytes()).toEqual(report.slice(0, 100))
    })

    it('should resume from where an earlier download stopped, while the content is the same', async () => {
      const client = connect()
      const first = await client.downloads.generated.get({ headers: { range: 'bytes=0-1023' } })
      const etag = first.headers.get('etag')!

      const rest = await client.downloads.generated.get({ headers: { range: 'bytes=1024-', 'if-range': etag } })

      expect(etag).toBe(GENERATED_ETAG)
      expect(rest.status).toBe(206)
      expect(await new Blob([await first.bytes(), await rest.bytes()]).bytes()).toEqual(report)
    })

    it('should hand back the whole content instead when it changed since the part already held', async () => {
      const res = await connect().downloads.generated.get({
        headers: { range: 'bytes=1024-', 'if-range': '"report-v0"' },
      })

      expect(res.status).toBe(200)
      expect(await res.bytes()).toEqual(report)
    })

    it('should answer 416 for a range past the end, saying how long the content is', async () => {
      const res = await connect().downloads.generated.get({ headers: { range: 'bytes=5000-' } })

      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */4096')
    })
  })
})

describe('brewer streaming a large download a route built in memory, over a socket', () => {
  it('should count every byte as it arrives, up to the length the server announced', async () => {
    const client = brewer<typeof app>(origin)
    const reported: number[] = []

    const res = await client.downloads.archive.get()
    let offset = 0
    for await (const chunk of res.body!.pipeThrough(client.$progress(loaded => reported.push(loaded)))) {
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== byteAt(offset + i)) {
          throw new Error(`byte ${offset + i} is ${chunk[i]}, not ${byteAt(offset + i)}`)
        }
      }
      offset += chunk.byteLength
    }

    expect(Number(res.headers.get('content-length'))).toBe(ARCHIVE)
    expect(offset).toBe(ARCHIVE)
    expect(reported.at(-1)).toBe(ARCHIVE)
  })
})

describe('brewer streaming a download over a socket', () => {
  it('should hand over each chunk as the server writes it, before the next one exists', async () => {
    const client = brewer<typeof app>(origin)
    const body = feed()
    body.write('first ')

    const res = await client.downloads.feed.get()
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()

    expect((await reader.read()).value).toBe('first ')
    body.write('second')
    expect((await reader.read()).value).toBe('second')
    body.end()
    expect((await reader.read()).done).toBe(true)
  })

  it('should count the bytes of a large download as they arrive, up to its length', async () => {
    const client = brewer<typeof app>(origin)
    const reported: number[] = []

    const res = await client.downloads.large.get()
    const total = Number(res.headers.get('content-length'))
    let offset = 0
    let chunks = 0
    for await (const chunk of res.body!.pipeThrough(client.$progress(loaded => reported.push(loaded)))) {
      chunks++
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== byteAt(offset + i)) {
          throw new Error(`byte ${offset + i} is ${chunk[i]}, not ${byteAt(offset + i)}`)
        }
      }
      offset += chunk.byteLength
    }

    expect(total).toBe(LARGE)
    expect(offset).toBe(LARGE)
    expect(chunks).toBeGreaterThan(1)
    expect(reported.at(-1)).toBe(LARGE)
    expect(reported).toEqual([...reported].sort((a, b) => a - b))
  })

  it('should stop a download part-way when the call aborts, and the server stop writing it', async () => {
    const client = brewer<typeof app>(origin)
    const controller = new AbortController()
    const body = feed()
    body.write('part one')

    const res = await client.downloads.feed.get({ signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await body.cancelled
  })

  it('should let the server stop writing when the reader cancels the body', async () => {
    const client = brewer<typeof app>(origin)
    const body = feed()
    body.write('part one')

    const res = await client.downloads.feed.get()
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()

    await body.cancelled
  })

  // Server-sent events: each event ends at a blank line, and is read as soon as it arrives.
  it('should read server-sent events one by one, as the server sends them', async () => {
    const client = brewer<typeof app>(origin)
    const body = feed()
    body.write('event: progress\ndata: {"done":1}\n\n')

    const res = await client.downloads.events.get({ headers: { accept: 'text/event-stream' } })
    const events = frames(res.body!, '\n\n')

    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await events.next()).toEqual({ done: false, value: 'event: progress\ndata: {"done":1}' })
    body.write('event: progress\ndata: {"done":2}\n\n')
    expect(await events.next()).toEqual({ done: false, value: 'event: progress\ndata: {"done":2}' })
    body.end()
    expect((await events.next()).done).toBe(true)
  })

  // A chunk ends wherever the network cut it, mid-line and mid-character included: lines are read across them.
  it('should read newline-delimited JSON whose lines and characters are split across chunks', async () => {
    const client = brewer<typeof app>(origin)
    const body = feed()
    const encoded = new TextEncoder().encode('{"pet":"Mílou"}\n{"pet":"Rex"}\n')
    const cut = encoded.indexOf(0xc3) + 1
    body.write(encoded.slice(0, cut))

    const res = await client.downloads.lines.get()
    const lines = frames(res.body!, '\n')
    const read = lines.next()
    body.write(encoded.slice(cut))
    body.end()

    expect(JSON.parse((await read).value!)).toEqual({ pet: 'Mílou' })
    expect(JSON.parse((await lines.next()).value!)).toEqual({ pet: 'Rex' })
    expect((await lines.next()).done).toBe(true)
  })
})

/** The text of a stream cut at each `separator`, read as it arrives: the standard pieces, decoder and reader. */
async function* frames(body: ReadableStream<Uint8Array<ArrayBuffer>>, separator: string): AsyncGenerator<string, void> {
  let buffered = ''

  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buffered += text
    let end = buffered.indexOf(separator)
    while (end !== -1) {
      yield buffered.slice(0, end)
      buffered = buffered.slice(end + separator.length)
      end = buffered.indexOf(separator)
    }
  }
}
