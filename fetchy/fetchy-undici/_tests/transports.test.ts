import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  Accept,
  API,
  type Authenticator,
  Body,
  ErrFetchyHTTP,
  ErrFetchyInvalidFormBody,
  ErrFetchyInvalidPathArgument,
  type FetchyBuilder,
  type FetchyClient,
  type FetchyResponse,
  Field,
  FormURLEncoded,
  GET,
  HEAD,
  Header,
  HeaderMap,
  Multipart,
  newClient,
  Param,
  Params,
  POST,
  PUT,
  Query,
  RawRequestBodyConverter,
  RawResponse,
  Retry,
  SignalParam,
  TextResponseConverter,
  type TransportFactory,
  UseRequestBodyConverter,
  UseResponseConverter,
} from '@caffeinejs/fetchy'
import { FetchTransportFactory } from '@caffeinejs/fetchy/fetch'
import { RetryInterceptor } from '@caffeinejs/fetchy/retry'
import { FormData as UndiciFormData } from 'undici'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { UndiciTransportFactory } from '../undici_transport_factory.js'

/**
 * The same calls over each transport, against a server that records every request it reads whole. What the server
 * receives and what a call returns are the same over both, but for three differences that are the transports' own:
 *
 * - a network failure: fetch rejects with a `TypeError` whose `cause` carries the code, undici with the coded error;
 * - `@RawResponse()`: fetch returns its native `Response`, undici an `UndiciResponse`, not an `instanceof Response`;
 * - fetch adds request headers of its own (`accept`, `user-agent`, ...), so a case asserts only the headers it is about.
 */

interface Received {
  method: string
  url: string
  headers: IncomingHttpHeaders
  headersDistinct: NodeJS.Dict<string[]>
  body: Buffer
}

interface Answer {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer
}

interface Latch {
  started: PromiseWithResolvers<void>
  released: PromiseWithResolvers<void>
}

type Reply = Answer | { drop: true } | { hold: Latch }

interface Echo {
  method: string
  url: string
}

let server: Server
let baseURL: string
const received: Received[] = []
const replies: Reply[] = []
const latches: Latch[] = []
const clients: FetchyClient[] = []

// What the server answers unless a test queued a reply: the request line it read, as JSON.
function echo(req: { method?: string; url?: string }): Answer {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: req.method, url: req.url }),
  }
}

function answer(res: ServerResponse, reply: Answer): void {
  res.writeHead(reply.status, reply.headers)
  res.end(reply.body)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        headersDistinct: req.headersDistinct,
        body: Buffer.concat(chunks),
      })

      const reply = replies.shift() ?? echo(req)

      if ('drop' in reply) {
        req.socket.destroy()
      } else if ('hold' in reply) {
        reply.hold.started.resolve()
        // The client may have given up on the request meanwhile, and its socket with it.
        void reply.hold.released.promise.then(() => {
          if (!res.destroyed) {
            answer(res, echo(req))
          }
        })
      } else {
        answer(res, reply)
      }
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

// `close()` waits for the requests in flight, so a test that failed while the server held one would hang here and hide
// its failure: every held request is let go first.
afterEach(async () => {
  for (const latch of latches.splice(0)) {
    latch.released.resolve()
  }

  await Promise.all(clients.splice(0).map(client => client.close()))
})

function clientOver(
  factory: TransportFactory,
  configure: (builder: FetchyBuilder) => FetchyBuilder = builder => builder,
): FetchyClient {
  const client = configure(newClient().baseURL(baseURL).transportFactory(factory)).build()
  clients.push(client)
  return client
}

// The server holds its answer to the next request until the test releases it.
function holdNext(): { started: Promise<void>; release: () => void } {
  const latch: Latch = { started: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }
  latches.push(latch)
  replies.push({ hold: latch })

  return { started: latch.started.promise, release: () => latch.released.resolve() }
}

// Parses a recorded request as a server does: by the boundary its content-type names.
function partsOf(request: Received) {
  return new Response(request.body, { headers: { 'content-type': request.headers['content-type']! } }).formData()
}

function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
}

const report = '%PDF-1.7 Q3 report'

// A FormData of undici's own, which is no instance of the global class, holding a text part and a file part.
function reportForm(): UndiciFormData {
  const form = new UndiciFormData()
  form.append('title', 'Q3 report')
  form.append('file', new File([report], 'report.pdf', { type: 'application/pdf' }))
  return form
}

async function expectReportParts(request: Received): Promise<void> {
  const parts = await partsOf(request)
  const file = parts.get('file') as File

  expect(parts.get('title')).toBe('Q3 report')
  expect(file.name).toBe('report.pdf')
  expect(await file.text()).toBe(report)
}

// Where RetryInterceptor looks for the code it matches against `errorCodes`.
function codeOf(error: unknown): unknown {
  const failure = error as { code?: unknown; cause?: { code?: unknown } } | null
  return failure?.code ?? failure?.cause?.code
}

@API('/items')
class ItemsAPI {
  @GET('/{id}')
  @Params([Param('id'), SignalParam()])
  get!: (id: string, signal?: AbortSignal) => Promise<Echo>

  @GET('/{id}')
  @Retry({ delay: 1 })
  @Params([Param('id')])
  getWithRetry!: (id: string) => Promise<Echo>

  @GET('')
  @Params([Query('tag'), Query('page'), Query('draft'), Query('q'), Query('x')])
  search!: (tags: unknown[], page: number, draft: boolean, q: string, x?: string) => Promise<Echo>

  @GET('/search?type=user')
  @Params([Query('q')])
  searchUsers!: (q: string) => Promise<Echo>

  @POST('')
  @Params([Body()])
  create!: (body: unknown) => Promise<unknown>

  @POST('/uploads')
  @Multipart()
  @Params([Body()])
  upload!: (form: unknown) => Promise<unknown>

  @POST('/token')
  @FormURLEncoded()
  @Params([Body()])
  token!: (body: unknown) => Promise<unknown>

  @POST('/subscribers')
  @FormURLEncoded()
  @Params([Field('name'), Field('role')])
  subscribe!: (name: string, role: string) => Promise<unknown>

  @HEAD('/{id}')
  @Params([Param('id')])
  exists!: (id: string) => Promise<unknown>

  @GET('/{id}')
  @UseResponseConverter(TextResponseConverter)
  @Params([Param('id')])
  text!: (id: string) => Promise<string>

  @GET('/{id}')
  @RawResponse()
  @Params([Param('id')])
  raw!: (id: string) => Promise<FetchyResponse>
}

@API('/')
class RootAPI {
  @GET('/users')
  users!: () => Promise<Echo>
}

// The issue's own declaration: a FormData built by the caller, sent untouched.
@API('/documents')
class DocumentsAPI {
  @PUT('/{id}')
  @Retry({ delay: 1 })
  @UseRequestBodyConverter(RawRequestBodyConverter)
  @Params([Param('id'), Body()])
  replace!: (id: string, form: unknown) => Promise<unknown>
}

@API('/headers')
@HeaderMap({ 'X-Client': 'fetchy-tests' })
@Accept('application/json')
class HeadersAPI {
  @GET('')
  @Params([Header('X-Request-ID')])
  traced!: (requestID: string) => Promise<unknown>

  @GET('/me')
  @HeaderMap({ Authorization: 'Bearer declared' })
  me!: () => Promise<unknown>
}

const TRANSPORTS: [string, () => TransportFactory][] = [
  ['FetchTransport', () => new FetchTransportFactory()],
  ['UndiciTransport', () => new UndiciTransportFactory()],
]

describe.each(TRANSPORTS)('a call over %s', (_name, factory) => {
  describe('the request line', () => {
    // An ID is user data: every character a URL gives a meaning to has to reach the server as data.
    it('percent-encodes a path parameter', async () => {
      await clientOver(factory()).create(ItemsAPI).get('a b/c?d#e%ç')

      expect(received[0].url).toBe('/items/a%20b%2Fc%3Fd%23e%25%C3%A7')
    })

    // Encoding leaves a dot alone: fetch resolved `/items/..` to `/` and undici sent it as written, so the argument
    // picked the endpoint, and differently on each transport. An empty one called the collection.
    it.each(['..', '.', ''])('refuses a path argument of %j, and sends nothing', async id => {
      await expect(clientOver(factory()).create(ItemsAPI).get(id)).rejects.toBeInstanceOf(ErrFetchyInvalidPathArgument)

      expect(received).toEqual([])
    })

    // `0`, `false` and `''` are values a filter means, unlike an argument left out, alone or in a list.
    it('repeats an array in the query, keeps 0, false and an empty string, and leaves out null and undefined', async () => {
      await clientOver(factory()).create(ItemsAPI).search(['math', null, 'history', undefined], 0, false, '')

      expect(received[0].url).toBe('/items?tag=math&tag=history&page=0&draft=false&q=')
    })

    // A query the path writes and a parameter after it reach the server as two parameters, not one value.
    it('continues a query string the operation path writes', async () => {
      await clientOver(factory()).create(ItemsAPI).searchUsers('ada')

      expect([...new URL(received[0].url, baseURL).searchParams]).toEqual([
        ['type', 'user'],
        ['q', 'ada'],
      ])
    })

    // A server tells `//users` from `/users`, or answers it with 404.
    it("joins a base URL's path, a class path of '/' and an operation path with single slashes", async () => {
      await clientOver(factory(), builder => builder.baseURL(`${baseURL}/v1`))
        .create(RootAPI)
        .users()

      expect(received[0].url).toBe('/v1/users')
    })
  })

  describe('the headers', () => {
    it('sends the declared headers and the header arguments', async () => {
      await clientOver(factory()).create(HeadersAPI).traced('r-1')

      expect(received[0].headers).toMatchObject({
        'x-client': 'fetchy-tests',
        accept: 'application/json',
        'x-request-id': 'r-1',
      })
    })

    // An interceptor that refreshes a token sets it in whatever case it likes. Sent next to the declared one, the
    // server would read two credentials, or the stale one.
    it('lets an interceptor replace a declared header rather than send a second one', async () => {
      const api = clientOver(factory(), builder =>
        builder.addInterceptor(chain => {
          const request = chain.request()
          request.headers.set('Authorization', 'Bearer fresh')
          return chain.proceed(request)
        }),
      ).create(HeadersAPI)

      await api.me()

      expect(received[0].headersDistinct.authorization).toEqual(['Bearer fresh'])
    })
  })

  describe('the request body', () => {
    it('sends an object as JSON', async () => {
      await clientOver(factory()).create(ItemsAPI).create({ name: 'Ada' })

      expect(received[0].headers['content-type']).toBe('application/json')
      expect(received[0].body.toString()).toBe('{"name":"Ada"}')
    })

    it('sends a string as text', async () => {
      await clientOver(factory()).create(ItemsAPI).create('already encoded')

      expect(received[0].headers['content-type']).toBe('text/plain;charset=UTF-8')
      expect(received[0].body.toString()).toBe('already encoded')
    })

    // Bytes go out as they are: through JSON a typed array would become an object of indexes, and an ArrayBuffer or a
    // stream the text `{}`. Over fetch, a stream also needs `duplex`.
    it.each([
      ['a Uint8Array', (bytes: Uint8Array): unknown => bytes],
      ['a DataView', (bytes: Uint8Array): unknown => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)],
      ['an ArrayBuffer', (bytes: Uint8Array): unknown => bytes.slice().buffer],
      [
        'a ReadableStream',
        (bytes: Uint8Array): unknown =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 100))
              controller.enqueue(bytes.slice(100))
              controller.close()
            },
          }),
      ],
    ])('sends %s byte for byte, with no label', async (_kind, wrap) => {
      const bytes = Uint8Array.from({ length: 256 }, (_, byte) => byte)

      await clientOver(factory()).create(ItemsAPI).create(wrap(bytes))

      expect(sha256(received[0].body)).toBe(sha256(bytes))
      expect(received[0].headers['content-type']).toBeUndefined()
    })

    it('sends a Blob under its own type', async () => {
      await clientOver(factory())
        .create(ItemsAPI)
        .create(new Blob(['%PDF-1.7'], { type: 'application/pdf' }))

      expect(received[0].headers['content-type']).toBe('application/pdf')
      expect(received[0].body.toString()).toBe('%PDF-1.7')
    })

    it('sends a URLSearchParams as a form', async () => {
      await clientOver(factory())
        .create(ItemsAPI)
        .create(new URLSearchParams({ a: '1', b: '2' }))

      expect(received[0].headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8')
      expect(received[0].body.toString()).toBe('a=1&b=2')
    })

    // An OAuth token request is the usual form, and the server reads each field by name.
    it('form-encodes a @Body() object and Field() arguments under @FormURLEncoded()', async () => {
      const api = clientOver(factory()).create(ItemsAPI)

      await api.token({ grant_type: 'client_credentials', scope: 'read' })
      await api.subscribe('Ada', 'admin')

      expect(received.map(request => [request.headers['content-type'], request.body.toString()])).toEqual([
        ['application/x-www-form-urlencoded', 'grant_type=client_credentials&scope=read'],
        ['application/x-www-form-urlencoded', 'name=Ada&role=admin'],
      ])
    })

    // A lone number is not a form. fetch sent it as text and undici threw an error of its own; refused before anything
    // is sent, it now fails the same way on both.
    it('refuses a @Body() under @FormURLEncoded() that is not a form, and sends nothing', async () => {
      await expect(clientOver(factory()).create(ItemsAPI).token(42)).rejects.toBeInstanceOf(ErrFetchyInvalidFormBody)
      expect(received).toHaveLength(0)
    })

    // An optional body left out is no body, not the text "null" under a JSON label.
    // undici's FormData is no instance of the global class: the JSON converter sent it as `{}`, @Multipart() refused it,
    // and fetch sent it as the text "[object FormData]". Its parts reach the server whichever converter takes it.
    it.each([
      ['the JSON converter', (client: FetchyClient, form: UndiciFormData) => client.create(ItemsAPI).create(form)],
      ['@Multipart()', (client: FetchyClient, form: UndiciFormData) => client.create(ItemsAPI).upload(form)],
      [
        'RawRequestBodyConverter',
        (client: FetchyClient, form: UndiciFormData) => client.create(DocumentsAPI).replace('1', form),
      ],
    ])("sends every part of undici's own FormData under %s", async (_converter, send) => {
      await send(clientOver(factory()), reportForm())

      await expectReportParts(received[0])
    })

    it('sends no body and no content-type for an absent @Body()', async () => {
      await clientOver(factory()).create(ItemsAPI).create(undefined)

      expect(received[0].headers['content-type']).toBeUndefined()
      expect(received[0].body.length).toBe(0)
    })
  })

  describe('the response', () => {
    it('resolves with the parsed JSON body', async () => {
      await expect(clientOver(factory()).create(ItemsAPI).get('1')).resolves.toEqual({ method: 'GET', url: '/items/1' })
    })

    // Neither has a body to parse: a SyntaxError for it would fail a call that succeeded.
    it.each([
      ['a 204', { status: 204 }],
      ['an empty 200', { status: 200, headers: { 'content-type': 'application/json' }, body: '' }],
    ])('resolves %s with undefined', async (_kind, reply) => {
      replies.push(reply)

      await expect(clientOver(factory()).create(ItemsAPI).get('1')).resolves.toBeUndefined()
    })

    it('resolves a HEAD with undefined', async () => {
      await expect(clientOver(factory()).create(ItemsAPI).exists('1')).resolves.toBeUndefined()
      expect(received[0].method).toBe('HEAD')
    })

    it('reads the body as text under TextResponseConverter', async () => {
      replies.push({ status: 200, headers: { 'content-type': 'text/csv' }, body: 'id,name\n1,Ada\n' })

      await expect(clientOver(factory()).create(ItemsAPI).text('1')).resolves.toBe('id,name\n1,Ada\n')
    })

    // A raw response is the caller's to inspect, whatever its status.
    it('hands a @RawResponse() operation the status, the headers and a readable body', async () => {
      replies.push({ status: 418, headers: { 'x-request-id': 'r-1' }, body: 'short and stout' })

      const response = await clientOver(factory()).create(ItemsAPI).raw('1')

      expect(response.status).toBe(418)
      expect(response.ok).toBe(false)
      expect(response.headers.get('x-request-id')).toBe('r-1')
      expect(await response.text()).toBe('short and stout')
    })

    // Past what the socket buffers, a body arrives in many chunks, and every one of them has to be read.
    it('reads a large body whole', async () => {
      const size = 8 * 1024 * 1024
      replies.push({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(size, 'x') })

      const text = await clientOver(factory()).create(ItemsAPI).text('1')

      expect(text.length).toBe(size)
    })
  })

  describe('a failed call', () => {
    it('rejects with ErrFetchyHTTP carrying the status, the headers and the parsed body', async () => {
      replies.push({
        status: 404,
        headers: { 'content-type': 'application/json', 'x-request-id': 'r-404' },
        body: '{"message":"no such item"}',
      })

      const error = await clientOver(factory())
        .create(ItemsAPI)
        .get('9')
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ErrFetchyHTTP)
      expect(error).toMatchObject({ status: 404, statusText: 'Not Found', body: { message: 'no such item' } })
      expect((error as ErrFetchyHTTP).headers.get('x-request-id')).toBe('r-404')
    })

    // A gateway answers an outage with an HTML page: the caller still gets the status to act on.
    it('rejects an error page that is not JSON with ErrFetchyHTTP and no body', async () => {
      replies.push({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad Gateway</html>' })

      const error = await clientOver(factory())
        .create(ItemsAPI)
        .get('1')
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ErrFetchyHTTP)
      expect(error).toMatchObject({ status: 502, body: undefined })
    })

    // A body that claims to be JSON and is not fails loudly, rather than resolving with what the server did not send.
    it('rejects a 200 whose body is not JSON with a SyntaxError', async () => {
      replies.push({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":' })

      await expect(clientOver(factory()).create(ItemsAPI).get('1')).rejects.toBeInstanceOf(SyntaxError)
    })

    // A connection dropped before any answer is the transient failure a retry exists for, and the code RetryInterceptor
    // matches has to be where it looks, on both transports.
    it('rejects when the connection drops, with a code a retry recognizes', async () => {
      replies.push({ drop: true })

      const error = await clientOver(factory())
        .create(ItemsAPI)
        .get('1')
        .catch((caught: unknown) => caught)

      expect(['UND_ERR_SOCKET', 'ECONNRESET']).toContain(codeOf(error))
    })

    it('retries a GET whose connection dropped', async () => {
      replies.push({ drop: true })
      const api = clientOver(factory(), builder => builder.addInterceptor(RetryInterceptor.INSTANCE)).create(ItemsAPI)

      await expect(api.getWithRetry('1')).resolves.toEqual({ method: 'GET', url: '/items/1' })
      expect(received).toHaveLength(2)
    })

    // Nothing is sent for a call given up already. The call after it shows whether the first one went out late.
    it('rejects with the reason of a signal aborted before the call, and sends nothing', async () => {
      const api = clientOver(factory()).create(ItemsAPI)
      const reason = new Error('navigated away')

      await expect(api.get('1', AbortSignal.abort(reason))).rejects.toBe(reason)
      await api.get('2')

      expect(received.map(request => request.url)).toEqual(['/items/2'])
    })

    // A caller that gives up, on a navigation or a timeout, gets its answer at once, not when the server is done.
    it('rejects with the abort reason while the server is still answering', async () => {
      const hold = holdNext()
      const controller = new AbortController()
      const reason = new Error('took too long')
      const call = clientOver(factory()).create(ItemsAPI).get('1', controller.signal)

      await hold.started
      controller.abort(reason)

      await expect(call).rejects.toBe(reason)
    })
  })

  describe('a call sent again', () => {
    // The retry goes out with the same request once the 503's body is let go.
    it('retries a 503 and resolves with the answer to the retry', async () => {
      replies.push({ status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"busy"}' })
      const api = clientOver(factory(), builder => builder.addInterceptor(RetryInterceptor.INSTANCE)).create(ItemsAPI)

      await expect(api.getWithRetry('1')).resolves.toEqual({ method: 'GET', url: '/items/1' })
      expect(received.map(request => request.url)).toEqual(['/items/1', '/items/1'])
    })

    it('answers a 401 with the follow-up the authenticator builds', async () => {
      replies.push({ status: 401, headers: { 'www-authenticate': 'Bearer' } })
      const authenticator: Authenticator = {
        authenticate(request) {
          const followUp = request.clone()
          followUp.headers.set('authorization', 'Bearer fresh')
          return Promise.resolve(followUp)
        },
      }
      const api = clientOver(factory(), builder => builder.authenticator(authenticator)).create(ItemsAPI)

      await expect(api.get('1')).resolves.toEqual({ method: 'GET', url: '/items/1' })
      expect(received.map(request => request.headers.authorization)).toEqual([undefined, 'Bearer fresh'])
    })
  })

  // One client serves calls from everywhere at once, and each call gets the answer to its own request.
  it('answers concurrent calls each with its own response', async () => {
    const api = clientOver(factory()).create(ItemsAPI)
    const ids = Array.from({ length: 25 }, (_, index) => String(index))

    const echoes = await Promise.all(ids.map(id => api.get(id)))

    expect(echoes.map(answered => answered.url)).toEqual(ids.map(id => `/items/${id}`))
  })
})

describe('a call over UndiciTransport', () => {
  // With one connection, the 503 holds it until its body is read or let go, and a retry behind an unread body would
  // wait for that connection forever. The body is more than the socket buffers hold, so undici cannot finish it alone.
  it('lets go of a retried response, so the retry gets the connection', async () => {
    replies.push({
      status: 503,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(4 * 1024 * 1024),
    })
    const api = clientOver(new UndiciTransportFactory({ connections: 1 }), builder =>
      builder.addInterceptor(RetryInterceptor.INSTANCE),
    ).create(ItemsAPI)

    await expect(api.getWithRetry('1')).resolves.toEqual({ method: 'GET', url: '/items/1' })
    expect(received).toHaveLength(2)
  })

  // undici exports a FormData of its own, which is not an instance of the global one, and the transport encodes every
  // implementation again on each send. Taken for a stream, it was never retried, and a 503 failed the upload at once.
  it("resends every part of undici's own FormData on a retry", async () => {
    replies.push({ status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"busy"}' })
    const api = clientOver(new UndiciTransportFactory(), builder =>
      builder.addInterceptor(RetryInterceptor.INSTANCE),
    ).create(DocumentsAPI)

    await expect(api.replace('1', reportForm())).resolves.toEqual({ method: 'PUT', url: '/documents/1' })
    expect(received).toHaveLength(2)

    for (const attempt of received) {
      await expectReportParts(attempt)
    }
  })

  // The same form was refused for the follow-up, with an error that took it for a stream the first send had read.
  it("resends every part of undici's own FormData on an authentication follow-up", async () => {
    replies.push({ status: 401, headers: { 'www-authenticate': 'Bearer' } })
    const authenticator: Authenticator = {
      authenticate(request) {
        const followUp = request.clone()
        followUp.headers.set('authorization', 'Bearer fresh')
        return Promise.resolve(followUp)
      },
    }
    const api = clientOver(new UndiciTransportFactory(), builder => builder.authenticator(authenticator)).create(
      DocumentsAPI,
    )

    await expect(api.replace('1', reportForm())).resolves.toEqual({ method: 'PUT', url: '/documents/1' })
    expect(received.map(request => request.headers.authorization)).toEqual([undefined, 'Bearer fresh'])

    for (const attempt of received) {
      await expectReportParts(attempt)
    }
  })

  // Closing a client lets go of its connections, but not under a call that is still being answered.
  it('lets a call in flight finish when the client closes', async () => {
    const hold = holdNext()
    const client = clientOver(new UndiciTransportFactory())
    const call = client.create(ItemsAPI).get('1')

    await hold.started
    const closed = client.close()
    hold.release()

    await expect(call).resolves.toEqual({ method: 'GET', url: '/items/1' })
    await closed
  })
})
