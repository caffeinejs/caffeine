import { API, GET, Param, Params } from '@caffeinejs/fetchy'

/** Any slice by its id, for one the UI has no page of its own for. */
@API()
export class SliceAPI {
  @GET('/{id}')
  @Params([Param('id')])
  get!: (id: string) => Promise<unknown>
}
