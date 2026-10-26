import type {
  BindingRecord,
  ContainerEventRecord,
  DependencyGraph,
  DevToolsIndex,
  HealthRecord,
  InfoRecord,
  PropertyDetail,
  PropertyRecord,
  RefreshableRecord,
  RefreshRecord,
  RuntimeRecord,
  SecurityRecord,
  ServerRoutesRecord,
  SourceRecord,
} from '@caffeinejs/devtools'
import { API, Body, GET, newClient, Param, Params, POST, Query, type FetchyClient } from '@caffeinejs/fetchy'

import type { Config } from './app.config.js'

/**
 * The devtools endpoints the UI reads, one field per resource. The base URL is the devtools path itself, so a
 * resource here is written as the devtools serve it under `/devtools`.
 */
@API()
export class DevToolsAPI {
  // No path of its own: the index is the base URL as written, which a trailing slash would miss.
  @GET('')
  index!: () => Promise<DevToolsIndex>

  @GET('/info')
  info!: () => Promise<InfoRecord>

  @GET('/health')
  health!: () => Promise<HealthRecord>

  @GET('/di/bindings')
  @Params([Query('internal')])
  bindings!: (internal: 'true' | undefined) => Promise<BindingRecord[]>

  @GET('/di/graph')
  @Params([Query('internal')])
  graph!: (internal: 'true' | undefined) => Promise<DependencyGraph>

  @GET('/config/properties')
  properties!: () => Promise<PropertyRecord[]>

  @GET('/config/properties/{path}')
  @Params([Param('path')])
  property!: (path: string) => Promise<PropertyDetail>

  @GET('/config/sources')
  sources!: () => Promise<SourceRecord[]>

  @GET('/routes')
  routes!: () => Promise<ServerRoutesRecord[]>

  @GET('/routes/security')
  security!: () => Promise<SecurityRecord>

  @GET('/refreshables')
  refreshables!: () => Promise<RefreshableRecord[]>

  @POST('/refreshables/refreshes')
  @Params([Body()])
  refreshAll!: (body: { label?: string }) => Promise<RefreshRecord>

  @POST('/refreshables/{id}/refreshes')
  @Params([Param('id'), Body()])
  refreshOne!: (id: string, body: Record<string, never>) => Promise<RefreshRecord>

  @GET('/events')
  events!: () => Promise<ContainerEventRecord[]>

  @GET('/runtime')
  runtime!: () => Promise<RuntimeRecord>

  /** A contributed tool's root resource: `GET /devtools/<tool>`. */
  @GET('/{tool}')
  @Params([Param('tool')])
  toolRoot!: (tool: string) => Promise<unknown>

  /** A contributed tool's resource one segment under its root: `GET /devtools/<tool>/<resource>`. */
  @GET('/{tool}/{resource}')
  @Params([Param('tool'), Param('resource')])
  toolResource!: (tool: string, resource: string) => Promise<unknown>
}

/** The client every page reads the devtools through, sending `target.authorization` when it is set. */
export function devToolsClient(config: Config): FetchyClient {
  const builder = newClient().baseURL(config.target.url)
  const authorization = config.target.authorization

  if (authorization !== undefined) {
    builder.addInterceptor(chain => {
      const request = chain.request()
      request.headers.set('authorization', authorization)
      return chain.proceed(request)
    })
  }

  return builder.build()
}
