import { createHash, randomBytes } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import {
  createServer as createH2CServer,
  type Http2Server,
  type IncomingHttpHeaders as IncomingHttp2Headers,
  type ServerHttp2Stream,
} from 'node:http2'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { FetchyHeaders, FetchyRequest } from '@caffeinejs/fetchy'
import { Client, Pool } from 'undici'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { UndiciTransport } from '../index.js'
import { startTestServer, type TestServer } from './test_server.js'

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, byte) => byte)
const MiB = 1024 * 1024

interface Received {
  contentType: string
  contentLength: string
  transferEncoding: string
  bytes: Uint8Array
}

// Parses what a server read as the server does: by the boundary its content-type names.
function partsOf(received: Pick<Received, 'contentType' | 'bytes'>) {
  return new Response(received.bytes, { headers: { 'content-type': received.contentType } }).formData()
}

type Parts = Awaited<ReturnType<typeof partsOf>>

function boundaryOf(contentType: string): string {
  return contentType.split('boundary=')[1]
}

// Bytes as text that survives every byte value, with the boundary, which differs on each send, written out.
function withoutBoundary(bytes: Uint8Array, boundary: string): string {
  return Buffer.from(bytes).toString('latin1').split(boundary).join('<boundary>')
}

function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
}

// A file part made up as it is read, so the test holds no more of it than the transport asks for. It reports `size`,
// and holds as many bytes unless `bytes` says otherwise: `Infinity` never ends.
function generatedFile(size: number, { bytes = size, onCancel = (): void => undefined } = {}) {
  let read = 0
  let cancelled = false
  const file = Object.defineProperties(new File([], 'large.bin', { type: 'application/octet-stream' }), {
    size: { value: size },
    stream: {
      value: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const length = Math.min(64 * 1024, bytes - read)

            if (length === 0) {
              controller.close()
              return
            }

            read += length
            controller.enqueue(new Uint8Array(length))
          },
          cancel() {
            cancelled = true
            onCancel()
          },
        }),
    },
  }) as File

  return { file, read: () => read, cancelled: () => cancelled }
}

interface PausingServer {
  readonly baseURL: string
  // Settles once the first bytes of an upload arrived and the server stopped reading.
  readonly paused: Promise<void>
  resume(): void
  // Settles with what the server read once the upload ended.
  readonly received: Promise<{ bytes: number; headers: IncomingHttpHeaders }>
  stop(): Promise<void>
}

// A server that stops reading an upload after its first bytes until it is told to go on, as a slow one would.
async function startPausingServer(): Promise<PausingServer> {
  let onPaused!: () => void
  let onReceived!: (received: { bytes: number; headers: IncomingHttpHeaders }) => void
  let resume = (): void => undefined
  const paused = new Promise<void>(resolve => (onPaused = resolve))
  const received = new Promise<{ bytes: number; headers: IncomingHttpHeaders }>(resolve => (onReceived = resolve))
  const server: Server = createServer((req, res) => {
    let bytes = 0

    req.on('data', (chunk: Buffer) => {
      if (bytes === 0) {
        req.pause()
        resume = () => req.resume()
        onPaused()
      }

      bytes += chunk.length
    })
    req.on('end', () => {
      onReceived({ bytes, headers: req.headers })
      res.end('done')
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paused,
    resume: () => resume(),
    received,
    stop: () =>
      new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

describe('UndiciTransport on a multipart upload', () => {
  let server: TestServer
  let pool: Pool
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fetchy-undici-upload-'))
  })

  afterAll(() => rm(dir, { recursive: true, force: true }))

  beforeEach(async () => {
    server = await startTestServer()
    pool = new Pool(server.baseURL)
  })

  afterEach(async () => {
    await pool.destroy()
    await server.stop()
  })

  // Sends `body` to the raw echo and returns what the server read, as it read it.
  async function upload(body: unknown, headers: Record<string, string> = {}, via = pool): Promise<Received> {
    const response = await new UndiciTransport(via).send(
      new FetchyRequest(
        'POST',
        server.baseURL,
        '/upload',
        new FetchyHeaders({ ...headers, 'x-test-echo': 'raw' }),
        body as FetchyRequest['body'],
      ),
    )

    return {
      contentType: response.headers.get('content-type')!,
      contentLength: response.headers.get('x-test-content-length')!,
      transferEncoding: response.headers.get('x-test-transfer-encoding')!,
      bytes: new Uint8Array(await response.arrayBuffer()),
    }
  }

  // Servers are written, and tested, against what browsers and fetch send. With the same bytes, an upload one of them
  // takes from fetch it takes from this transport.
  it('writes the bytes fetch would, apart from the boundary', async () => {
    const form = new FormData()
    form.append('title', 'Q3 réport\nline 2\rline 3\r\n')
    form.append('a"b\r\nc', 'a quoted name')
    form.append('file', new File([ALL_BYTES], 'q"x\r\n.bin'))
    form.append('csv', new File(['a,b\n1,2\r\n'], 'data.csv', { type: 'text/csv;charset=utf-8' }))
    form.append('blob', new Blob(['raw']))
    form.append('empty', new File([], 'empty.bin'))
    form.append('unnamed', new File(['text'], ''))
    form.append('intl', new File(['%PDF'], 'relatório 日本.pdf', { type: 'application/pdf' }))

    const received = await upload(form)
    const viaFetch = new Request('http://example.test', { method: 'POST', body: form })

    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(withoutBoundary(received.bytes, boundaryOf(received.contentType))).toBe(
      withoutBoundary(new Uint8Array(await viaFetch.arrayBuffer()), boundaryOf(viaFetch.headers.get('content-type')!)),
    )
  })

  // A server or a proxy may refuse a chunked upload, and one with the wrong length fails or is cut short.
  it('declares the exact length of what it sends, text beyond ASCII included', async () => {
    const form = new FormData()
    form.append('título', 'Olá, 世界 𝄞')
    form.append('arquivo', new File(['conteúdo'], 'relatório.txt'))

    const received = await upload(form)

    expect(received.transferEncoding).toBe('')
    expect(Number(received.contentLength)).toBe(received.bytes.byteLength)
    expect((await partsOf(received)).get('título')).toBe('Olá, 世界 𝄞')
  })

  // RFC 2046 limits a boundary to 70 characters from a small set, and a strict parser refuses any other.
  it('names a boundary RFC 2046 allows', async () => {
    const form = new FormData()
    form.append('title', 'Q3 report')

    const received = await upload(form)

    expect(boundaryOf(received.contentType)).toMatch(/^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/)
  })

  // What a FormData holds is read when the send begins, as fetch reads it: a part appended afterwards neither goes out
  // nor makes the body longer than the length it was declared with.
  it('sends the parts the FormData held when the send began', async () => {
    const form = new FormData()
    form.append('title', 'Q3 report')

    const sending = upload(form)
    form.append('late', 'not sent')
    const received = await sending

    expect([...(await partsOf(received)).keys()]).toEqual(['title'])
    expect(Number(received.contentLength)).toBe(received.bytes.byteLength)
  })

  it.each<[string, [string, string | Blob][], (parts: Parts) => Promise<void>]>([
    [
      'a PDF, under its name and type',
      [['file', new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })]],
      async parts => {
        const file = parts.get('file') as File

        expect(file.name).toBe('report.pdf')
        expect(file.type).toBe('application/pdf')
        expect(await file.text()).toBe('%PDF-1.7')
      },
    ],
    [
      'every byte value, unchanged',
      [['file', new File([ALL_BYTES], 'bytes.bin')]],
      async parts => expect(new Uint8Array(await (parts.get('file') as File).arrayBuffer())).toEqual(ALL_BYTES),
    ],
    [
      "a text file's line breaks, byte for byte",
      [['file', new File(['a\nb\r\nc\rd'], 'lines.txt', { type: 'text/plain' })]],
      async parts => expect(await (parts.get('file') as File).text()).toBe('a\nb\r\nc\rd'),
    ],
    [
      'an empty file',
      [['file', new File([], 'empty.bin')]],
      async parts => {
        expect((parts.get('file') as File).name).toBe('empty.bin')
        expect((parts.get('file') as File).size).toBe(0)
      },
    ],
    [
      'an untyped file, as bytes',
      [['file', new File(['x'], 'data')]],
      async parts => expect((parts.get('file') as File).type).toBe('application/octet-stream'),
    ],
    [
      'a type with parameters',
      [['file', new File(['a,b'], 'data.csv', { type: 'text/csv;charset=utf-8' })]],
      async parts => expect((parts.get('file') as File).type).toBe('text/csv;charset=utf-8'),
    ],
    [
      'a bare Blob, under the name blob',
      [['file', new Blob(['raw'])]],
      async parts => expect((parts.get('file') as File).name).toBe('blob'),
    ],
    [
      'a filename beyond ASCII',
      [['file', new File(['x'], 'relatório 日本.pdf')]],
      async parts => expect((parts.get('file') as File).name).toBe('relatório 日本.pdf'),
    ],
    [
      'a filename that tries to open a header of its own',
      [['file', new File(['<p>'], 'evil".txt\r\nContent-Type: text/html', { type: 'text/plain' })]],
      async parts => {
        expect((parts.get('file') as File).name).toBe('evil".txt\r\nContent-Type: text/html')
        expect((parts.get('file') as File).type).toBe('text/plain')
      },
    ],
    [
      'several files under one name, in order',
      [
        ['files', new File(['a'], 'a.txt')],
        ['files', new File(['b'], 'b.txt')],
      ],
      async parts => expect(parts.getAll('files').map(file => (file as File).name)).toEqual(['a.txt', 'b.txt']),
    ],
    [
      'a text value beyond ASCII, its line breaks as CRLF, as browsers send form fields',
      [['note', 'Olá, 世界 𝄞\nnext']],
      async parts => expect(parts.get('note')).toBe('Olá, 世界 𝄞\r\nnext'),
    ],
  ])('delivers %s as the server parses it back', async (_kind, entries, check) => {
    const form = new FormData()

    for (const [name, value] of entries) {
      form.append(name, value)
    }

    await check(await partsOf(await upload(form)))
  })

  // An interceptor that labels every request JSON is common, and undici would send a FormData under that label.
  it('replaces the content-type and content-length the request carries', async () => {
    const form = new FormData()
    form.append('title', 'Q3 report')

    const received = await upload(form, { 'content-type': 'application/json', 'content-length': '2' })

    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(Number(received.contentLength)).toBe(received.bytes.byteLength)
  })

  // A file from disk is the usual upload. It is read from disk as it is sent, and arrives whole.
  it('delivers a file-backed Blob byte for byte', async () => {
    const bytes = randomBytes(3 * MiB)
    const path = join(dir, 'report.bin')
    await writeFile(path, bytes)
    const form = new FormData()
    form.append('file', await openAsBlob(path), 'report.bin')

    const parts = await partsOf(await upload(form))

    expect(sha256(await (parts.get('file') as File).arrayBuffer())).toBe(sha256(bytes))
  })

  // A file deleted or changed after it was opened cannot be read. fetch, and undici's own encoder, leave such a call
  // pending forever and the error unhandled, which ends a Node process.
  it('rejects when a file part cannot be read, and leaves no rejection unhandled', async () => {
    const path = join(dir, 'removed.bin')
    await writeFile(path, randomBytes(1024))
    const blob = await openAsBlob(path)
    await unlink(path)
    const form = new FormData()
    form.append('file', blob, 'removed.bin')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      await expect(upload(form)).rejects.toMatchObject({ name: 'NotReadableError' })
      await new Promise(resolve => setImmediate(resolve))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  // The length goes out before the first byte, and undici holds a body to it only with `strictContentLength` on. A part
  // that runs past its size would leave the extra bytes on the connection, read as the next request, and one that ends
  // short of it would leave the server waiting. The transport fails either before the difference is sent. The longer
  // part never ends, so the call fails with the length error only if the part is cut off at its size.
  it.each([
    ['shorter', 3],
    ['longer', Infinity],
  ])('fails a part %s than its size, where the dispatcher checks no length', async (_, bytes) => {
    const lax = new Pool(server.baseURL, { strictContentLength: false })
    const form = new FormData()
    form.append('file', generatedFile(10, { bytes }).file)

    try {
      await expect(upload(form, {}, lax)).rejects.toMatchObject({ code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' })
    } finally {
      await lax.destroy()
    }
  })

  // A retry or an authentication follow-up sends the same request again, FormData and all.
  it('sends the same FormData complete each time', async () => {
    const form = new FormData()
    form.append('title', 'Q3 report')
    form.append('file', new File([ALL_BYTES], 'bytes.bin'))

    for (const received of [await upload(form), await upload(form)]) {
      const parts = await partsOf(received)

      expect(parts.get('title')).toBe('Q3 report')
      expect(new Uint8Array(await (parts.get('file') as File).arrayBuffer())).toEqual(ALL_BYTES)
    }
  })

  // undici sends a request with a streamed body alone on its connection, so the uploads wait their turn rather than
  // mix their bytes.
  it('delivers concurrent uploads over one connection intact', async () => {
    const single = new Pool(server.baseURL, { connections: 1 })
    const files = [1, 2, 3].map(n => new File([randomBytes(512 * 1024)], `file-${n}.bin`))

    try {
      const sent = await Promise.all(
        files.map(async file => {
          const form = new FormData()
          form.append('file', file)

          const parts = await partsOf(await upload(form, {}, single))

          return sha256(await (parts.get('file') as File).arrayBuffer())
        }),
      )

      expect(sent).toEqual(await Promise.all(files.map(async file => sha256(await file.arrayBuffer()))))
    } finally {
      await single.destroy()
    }
  })

  // The form-data package's streams carry the FormData tag without being one. undici sends them as streams, and so must
  // this transport.
  it('sends a stream that calls itself FormData as a stream', async () => {
    const stream = Object.defineProperty(Readable.from(['part one, ', 'part two']), Symbol.toStringTag, {
      value: 'FormData',
    })

    const received = await upload(stream)

    expect(Buffer.from(received.bytes).toString()).toBe('part one, part two')
  })

  it('sends bytes as they are', async () => {
    const received = await upload(ALL_BYTES)

    expect(received.bytes).toEqual(ALL_BYTES)
  })
})

describe('UndiciTransport streaming a large upload', () => {
  let server: PausingServer
  let pool: Pool

  beforeEach(async () => {
    server = await startPausingServer()
    pool = new Pool(server.baseURL)
  })

  afterEach(async () => {
    await pool.destroy()
    await server.stop()
  })

  // Memory holds what the socket has yet to take, never the whole file: a 64 MiB part is read no further ahead than a
  // paused server lets it.
  it('reads a part only as fast as the server takes it', async () => {
    const { file, read } = generatedFile(64 * MiB)
    const form = new FormData()
    form.append('file', file)

    const sending = new UndiciTransport(pool).send(
      new FetchyRequest('POST', server.baseURL, '/upload', undefined, form),
    )

    await server.paused
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(read()).toBeLessThan(16 * MiB)

    server.resume()
    await (await sending).text()
    const { bytes, headers } = await server.received

    expect(bytes).toBe(Number(headers['content-length']))
    expect(bytes).toBeGreaterThan(64 * MiB)
  })

  // An upload the caller gave up on lets go of the file it reads from.
  it('stops reading a part when the upload is aborted', async () => {
    const { file, cancelled } = generatedFile(64 * MiB)
    const form = new FormData()
    form.append('file', file)
    const controller = new AbortController()

    const sending = new UndiciTransport(pool).send(
      new FetchyRequest('POST', server.baseURL, '/upload', undefined, form, controller.signal),
    )

    await server.paused
    controller.abort(new Error('cancelled by the user'))

    await expect(sending).rejects.toThrow('cancelled by the user')
    await vi.waitFor(() => expect(cancelled()).toBe(true))
  })

  // A part that fails to close must not turn the abort into an unhandled rejection, which ends a Node process.
  it('leaves no rejection unhandled when a part fails to close on abort', async () => {
    const { file, cancelled } = generatedFile(64 * MiB, {
      onCancel: () => {
        throw new Error('cannot close')
      },
    })
    const form = new FormData()
    form.append('file', file)
    const controller = new AbortController()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      const sending = new UndiciTransport(pool).send(
        new FetchyRequest('POST', server.baseURL, '/upload', undefined, form, controller.signal),
      )

      await server.paused
      controller.abort(new Error('cancelled by the user'))

      await expect(sending).rejects.toThrow('cancelled by the user')
      await vi.waitFor(() => expect(cancelled()).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

// undici 8 offers HTTP/2 to any TLS server, and takes it where the server prefers it, as many do.
describe('UndiciTransport over HTTP/2', () => {
  let server: Http2Server
  let baseURL: string
  let client: Client
  let onStream: (bytes: number, contentLength: string | undefined) => void
  let paused: Promise<void>

  beforeEach(async () => {
    let onPaused!: () => void
    paused = new Promise(resolve => (onPaused = resolve))
    server = createH2CServer()
    server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttp2Headers) => {
      let bytes = 0

      stream.on('data', (chunk: Buffer) => {
        if (bytes === 0 && headers['x-test-pause'] !== undefined) {
          stream.pause()
          onPaused()
        }

        bytes += chunk.length
      })
      stream.on('end', () => {
        onStream(bytes, headers['content-length'])

        // Answered late when asked to, so it stays in flight beside another request on the connection.
        setTimeout(
          () => {
            if (!stream.destroyed) {
              stream.respond({ ':status': 200 })
              stream.end('done')
            }
          },
          Number(headers['x-test-delay'] ?? 0),
        )
      })
      stream.on('error', () => undefined)
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // A Pool reads only the deprecated top-level `useH2c`, so a Client is the one dispatcher that takes h2c as typed.
    client = new Client(baseURL, { allowH2: true, h2Options: { useH2c: true } })
  })

  afterEach(async () => {
    await client.destroy()
    await new Promise(resolve => server.close(resolve))
  })

  it('streams a FormData with its length', async () => {
    const received = new Promise<{ bytes: number; contentLength: string | undefined }>(resolve => {
      onStream = (bytes, contentLength) => resolve({ bytes, contentLength })
    })
    const form = new FormData()
    form.append('file', new File([randomBytes(256 * 1024)], 'report.bin'))

    const response = await new UndiciTransport(client).send(
      new FetchyRequest('POST', baseURL, '/upload', undefined, form),
    )
    await response.text()
    const { bytes, contentLength } = await received

    expect(bytes).toBe(Number(contentLength))
  })

  // undici sends an HTTP/2 body unchecked, and a server ends the whole connection over a stream that runs past its
  // length, failing every request on it with that one upload. The transport fails the part alone, with the error
  // HTTP/1.1 gives.
  it.each([
    ['shorter', 3],
    ['longer', Infinity],
  ])('fails a part %s than its size alone, with the length error', async (_, bytes) => {
    onStream = () => undefined
    const transport = new UndiciTransport(client)
    const inFlight = transport.send(
      new FetchyRequest('GET', baseURL, '/slow', new FetchyHeaders({ 'x-test-delay': '200' })),
    )
    const form = new FormData()
    form.append('file', generatedFile(10, { bytes }).file)

    await expect(transport.send(new FetchyRequest('POST', baseURL, '/upload', undefined, form))).rejects.toMatchObject({
      code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
    })

    const answer = await inFlight

    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('done')
  })

  // undici's HTTP/2 writer stops asking for more of an aborted body without closing it, so the file is let go of
  // through the call's own signal.
  it('stops reading a part when the upload is aborted', async () => {
    const { file, cancelled } = generatedFile(64 * MiB)
    const form = new FormData()
    form.append('file', file)
    const controller = new AbortController()

    const sending = new UndiciTransport(client).send(
      new FetchyRequest(
        'POST',
        baseURL,
        '/upload',
        new FetchyHeaders({ 'x-test-pause': '1' }),
        form,
        controller.signal,
      ),
    )

    await paused
    controller.abort(new Error('cancelled by the user'))

    await expect(sending).rejects.toThrow('cancelled by the user')
    await vi.waitFor(() => expect(cancelled()).toBe(true))
  })
})
