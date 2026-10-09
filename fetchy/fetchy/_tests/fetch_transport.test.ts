import { createHash, randomBytes } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { RetryInterceptor } from '../builtin/retry/index.js'
import {
  API,
  type Authenticator,
  Body,
  ContentType,
  GET,
  Multipart,
  newClient,
  noop,
  Param,
  Params,
  Part,
  POST,
  PUT,
  Retry,
  SignalParam,
} from '../index.js'

/**
 * The default transport, `fetch`, against a server that records every request it reads. Each request is read whole
 * before it is answered, so a retry or a follow-up is sent only after the first attempt arrived complete.
 */

interface Received {
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
}

interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string
}

const OK: Reply = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }

let server: Server
let baseURL: string
const received: Received[] = []
const replies: Reply[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks) })

      const reply = replies.shift() ?? OK

      res.writeHead(reply.status, reply.headers)
      res.end(reply.body)
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

beforeEach(() => {
  received.length = 0
  replies.length = 0
})

// Parses a recorded request as a server does: by the boundary its content-type names.
function partsOf(request: Received) {
  return new Response(request.body, { headers: { 'content-type': request.headers['content-type']! } }).formData()
}

function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
}

@API('/documents')
class DocumentsAPI {
  @GET('/{id}')
  @Params([Param('id'), SignalParam()])
  get(_id: string, _signal?: AbortSignal): Promise<{ id: string }> {
    return noop()
  }

  @POST('/')
  @Multipart()
  @Params([Part('title'), Part('file')])
  upload(_title: string, _file: Blob): Promise<unknown> {
    return noop()
  }

  @PUT('/{id}')
  @Retry({ delay: 1 })
  @Multipart()
  @Params([Param('id'), Part('title'), Part('file')])
  replace(_id: string, _title: string, _file: Blob): Promise<unknown> {
    return noop()
  }
}

@API('/documents')
@ContentType('application/json')
class JSONByDefaultAPI {
  @POST('/')
  @Params([Body()])
  create(_body: unknown): Promise<unknown> {
    return noop()
  }
}

describe('FetchTransport', () => {
  it('sends through fetch when the builder names no transport', async () => {
    replies.push({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"1"}' })
    const api = newClient().baseURL(baseURL).build().create(DocumentsAPI)

    await expect(api.get('1')).resolves.toEqual({ id: '1' })
    expect(received[0].url).toBe('/documents/1')
  })

  it('rejects with the reason of an aborted call', async () => {
    const api = newClient().baseURL(baseURL).build().create(DocumentsAPI)
    const reason = new Error('navigated away')

    await expect(api.get('1', AbortSignal.abort(reason))).rejects.toBe(reason)
  })
})

describe('FetchTransport on a multipart upload', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fetchy-upload-'))
  })

  afterAll(() => rm(dir, { recursive: true, force: true }))

  // A file from disk is the usual upload, and fetchy hands it on untouched: every byte arrives, under its name.
  it('delivers a file-backed Blob byte for byte', async () => {
    const bytes = randomBytes(3 * 1024 * 1024)
    const path = join(dir, 'report.bin')
    await writeFile(path, bytes)
    const file = new File([await openAsBlob(path)], 'report.bin', { type: 'application/octet-stream' })
    const api = newClient().baseURL(baseURL).build().create(DocumentsAPI)

    await api.upload('Q3 report', file)

    const parts = await partsOf(received[0])
    const sent = parts.get('file') as File

    expect(Number(received[0].headers['content-length'])).toBe(received[0].body.length)
    expect(parts.get('title')).toBe('Q3 report')
    expect(sent.name).toBe('report.bin')
    expect(sha256(await sent.arrayBuffer())).toBe(sha256(bytes))
  })

  // An interceptor that labels every request JSON is common, and fetch would keep its label over the boundary. No length
  // set before the parts are encoded is theirs either, and fetch sends the one it is given: too short, the call never
  // ends.
  it('replaces the content-type and content-length an interceptor set on a FormData', async () => {
    const api = newClient()
      .baseURL(baseURL)
      .addInterceptor(chain => {
        const request = chain.request()
        request.headers.set('content-type', 'application/json')
        request.headers.set('content-length', '2')
        return chain.proceed(request)
      })
      .build()
      .create(DocumentsAPI)

    await api.upload('Q3 report', new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }))

    expect(received[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(Number(received[0].headers['content-length'])).toBe(received[0].body.length)
    expect((await partsOf(received[0])).get('title')).toBe('Q3 report')
  })

  it('sends a FormData a server can parse though the class declares JSON', async () => {
    const api = newClient().baseURL(baseURL).build().create(JSONByDefaultAPI)
    const form = new FormData()
    form.append('title', 'Q3 report')

    await api.create(form)

    expect((await partsOf(received[0])).get('title')).toBe('Q3 report')
  })

  // The parts are read again for each attempt: the retry sends the whole file, not what is left of it.
  it('resends every part on a retried PUT', async () => {
    const bytes = randomBytes(256 * 1024)
    replies.push({ status: 503 }, OK)
    const api = newClient().baseURL(baseURL).addInterceptor(RetryInterceptor.INSTANCE).build().create(DocumentsAPI)

    await api.replace('1', 'Q3 report', new File([bytes], 'report.bin'))

    expect(received).toHaveLength(2)

    for (const attempt of received) {
      const parts = await partsOf(attempt)

      expect(parts.get('title')).toBe('Q3 report')
      expect(sha256(await (parts.get('file') as File).arrayBuffer())).toBe(sha256(bytes))
    }
  })

  it('resends every part on an authentication follow-up', async () => {
    const bytes = randomBytes(256 * 1024)
    replies.push({ status: 401, headers: { 'www-authenticate': 'Bearer' } }, OK)
    const authenticator: Authenticator = {
      authenticate(request) {
        const next = request.clone()
        next.headers.set('authorization', 'Bearer token')
        return Promise.resolve(next)
      },
    }
    const api = newClient().baseURL(baseURL).authenticator(authenticator).build().create(DocumentsAPI)

    await api.upload('Q3 report', new File([bytes], 'report.bin'))

    expect(received).toHaveLength(2)
    expect(received[1].headers.authorization).toBe('Bearer token')

    for (const attempt of received) {
      expect(sha256(await ((await partsOf(attempt)).get('file') as File).arrayBuffer())).toBe(sha256(bytes))
    }
  })
})
