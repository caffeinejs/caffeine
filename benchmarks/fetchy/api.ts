import { API, Body, Param, Params, POST, Query } from '@caffeinejs/fetchy'

@API()
export class BenchAPI {
  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  post!: (id: string, filter: string, body: unknown) => Promise<unknown>
}
