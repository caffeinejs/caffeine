import {
  API,
  Body,
  FetchyRequest,
  HeaderMap,
  newClient,
  noop,
  Param,
  Params,
  POST,
  Query,
  type Call,
  type FetchyResponse,
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
const call: Call = { execute: () => answered }
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
  .callFactory({ provide: () => call })
  .build()
  .create(OverheadAPI)

const intercepted = newClient()
  .baseURL('http://bench.test')
  .callFactory({ provide: () => call })
  .addInterceptor(chain => chain.proceed(chain.request()))
  .build()
  .create(OverheadAPI)

group('in-memory call', () => {
  summary(() => {
    bench('control', async () => do_not_optimize(JSON.parse(await (await call.execute(controlRequest)).text())))
    bench('fetchy field', async () => do_not_optimize(await api.post(benchId, benchFilter, benchBody)))
    bench('fetchy method', async () => do_not_optimize(await api.postMethod(benchId, benchFilter, benchBody)))
    bench('fetchy method + interceptor', async () =>
      do_not_optimize(await intercepted.postMethod(benchId, benchFilter, benchBody)))
    bench('fetchy method, 3 declared headers', async () =>
      do_not_optimize(await api.postWithHeaders(benchId, benchFilter, benchBody)))
  })
})

await run({ throw: true, colors: process.stdout.isTTY === true })
