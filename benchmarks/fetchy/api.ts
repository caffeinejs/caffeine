import { API, Body, noop, Param, Params, POST, Query } from '@caffeinejs/fetchy'

@API()
export class BenchAPI {
  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  post!: (id: string, filter: string, body: unknown) => Promise<unknown>

  // The same request declared as a method: a method and a field operation reach their invoker differently.
  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  postMethod(_id: string, _filter: string, _body: unknown): Promise<unknown> {
    return noop()
  }
}
