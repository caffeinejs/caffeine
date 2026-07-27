import { API } from '../decorators/api.js'
import { Body } from '../decorators/params/body.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
import { Params } from '../decorators/params.js'
import { POST } from '../decorators/verbs.js'

@API()
export class BenchAPI {
  @POST('/{id}')
  @Params([Param('id'), Query('filter'), Body()])
  post!: (id: string, filter: string, body: unknown) => Promise<unknown>
}
