import {
  API,
  Body,
  FetchyRequest,
  GET,
  HeaderMap,
  newClient,
  noop,
  Param,
  Params,
  POST,
  Query,
  type FetchyResponse,
  type Transport,
} from '@caffeinejs/fetchy'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

import { benchBody, benchFilter, benchId } from './config.js'

// fetchy's own cost per call. `bench:fetchy` sends the same call over HTTP, where the network hides it. Here every
// row answers one prepared response from memory, so the rows differ only in what fetchy does around the transport,
// and each fetchy row minus `control` is that cost.

const payload = JSON.stringify(benchBody)

const response: FetchyResponse = {
  status: 200,
  statusText: 'OK',
  ok: true,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: null,
  bodyUsed: false,
  json: () => Promise.resolve(JSON.parse(payload)),
  text: () => Promise.resolve(payload),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
}

// One settled promise for every call: a transport allocates its own, and that cost is not fetchy's.
const answered = Promise.resolve(response)
const transport: Transport = { send: () => answered }
const controlRequest = new FetchyRequest('POST', 'http://bench.test', `/items/${benchId}`)

@API('/items')
class OverheadAPI {
  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  post!: (id: string, filter: string, body: unknown) => Promise<unknown>

  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  postMethod(_id: string, _filter: string, _body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/{id}')
  @HeaderMap({ 'X-Client': 'bench', 'X-Client-Version': '1.0.0', 'X-Trace': 'off' })
  @Params([Param('id'), Query('filter'), Body()])
  postWithHeaders(_id: string, _filter: string, _body: unknown): Promise<unknown> {
    return noop()
  }
}

const api = newClient()
  .baseURL('http://bench.test')
  .transportFactory({ provide: () => transport })
  .build()
  .create(OverheadAPI)

const intercepted = newClient()
  .baseURL('http://bench.test')
  .transportFactory({ provide: () => transport })
  .addInterceptor(chain => chain.proceed(chain.request()))
  .build()
  .create(OverheadAPI)

const authenticated = newClient()
  .baseURL('http://bench.test')
  .transportFactory({ provide: () => transport })
  .authenticator({ authenticate: () => Promise.resolve(null) })
  .build()
  .create(OverheadAPI)

// Dispatch alone: what reaching a client's invoker costs, measured in front of a synchronous invoker. The keys are
// fetchy's internal ones, read off a client because nothing exports them, as a benchmark may and an application must
// not. The own-property rows are what `create()` defined before symbol dispatch: the invoker as an own property of the
// client, collecting its arguments itself.
@API()
class DispatchAPI {
  @GET('/')
  method(_n: number): Promise<unknown> {
    return noop()
  }

  @GET('/')
  field!: (n: number) => Promise<unknown>
}

interface OwnProperty {
  own(n: number): unknown
}

const probe = newClient()
  .baseURL('http://bench.test')
  .transportFactory({ provide: () => transport })
  .build()
  .create(DispatchAPI)

function keyOf(name: string): symbol {
  const key = Object.getOwnPropertySymbols(probe).find(symbol => symbol.description === name)

  if (key === undefined) {
    throw new Error(`No dispatch key named "${name}" on a client`)
  }

  return key
}

const methodKey = keyOf('method')
const fieldKey = keyOf('field')

function dispatching<T extends object>(target: T): T & OwnProperty {
  const sink = (args: readonly unknown[]): unknown => do_not_optimize(args)

  Object.defineProperty(target, methodKey, { value: sink })
  Object.defineProperty(target, fieldKey, { value: sink })
  Object.defineProperty(target, 'own', {
    value: (...args: unknown[]): unknown => do_not_optimize(args),
    writable: true,
    configurable: true,
  })

  return target as T & OwnProperty
}

const single = dispatching(new DispatchAPI())
// One subclass per instance, so each call site meets 8 object shapes, as one base class serving 8 APIs does.
const eight = Array.from({ length: 8 }, () => dispatching(new (class extends DispatchAPI {})()))
const adapted = newClient()
  .baseURL('http://bench.test')
  .transportFactory({ provide: () => transport })
  .addCallAdapterFactory({
    provide: () => ({
      adapt:
        () =>
        (...args: unknown[]) =>
          do_not_optimize(args),
    }),
  })
  .build()
  .create(DispatchAPI)

// Bounded, so the argument stays a small integer for every case.
let n = 0
const next = (): number => (n = (n + 1) & 0xffff)

group('dispatch', () => {
  summary(() => {
    bench('own property, before symbol dispatch', () => do_not_optimize(single.own(next())))
    bench('method', () => do_not_optimize(single.method(next())))
    bench('field', () => do_not_optimize(single.field(next())))
    bench('method with a call adapter', () => do_not_optimize(adapted.method(next())))
  })
})

group('dispatch across 8 classes', () => {
  summary(() => {
    bench('own property, before symbol dispatch', () => {
      for (const target of eight) {
        do_not_optimize(target.own(next()))
      }
    })
    bench('method', () => {
      for (const target of eight) {
        do_not_optimize(target.method(next()))
      }
    })
  })
})

group('in-memory call', () => {
  summary(() => {
    bench('control', async () => do_not_optimize(JSON.parse(await (await transport.send(controlRequest)).text())))
    bench('fetchy field', async () => do_not_optimize(await api.post(benchId, benchFilter, benchBody)))
    bench('fetchy method', async () => do_not_optimize(await api.postMethod(benchId, benchFilter, benchBody)))
    bench('fetchy method + interceptor', async () =>
      do_not_optimize(await intercepted.postMethod(benchId, benchFilter, benchBody)))
    bench('fetchy method, 3 declared headers', async () =>
      do_not_optimize(await api.postWithHeaders(benchId, benchFilter, benchBody)))
    // Last: the rows above run before any call sends through an authenticator, as they did before it existed.
    bench('fetchy method + authenticator', async () =>
      do_not_optimize(await authenticated.postMethod(benchId, benchFilter, benchBody)))
  })
})

await run({ throw: true, colors: process.stdout.isTTY === true })
