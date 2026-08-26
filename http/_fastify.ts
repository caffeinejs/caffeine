import { type FastifyContext } from './context.js'
import { type CatchByMap } from './route.js'
import { type Principal } from './security/identity.js'
import { type AuthzRouteService } from './security/authz/route_service.js'

declare module 'fastify' {
  interface FastifyRequest {
    httpContext: FastifyContext
    responseCached: boolean
    controller: Record<string | symbol, unknown> | null
    user: Principal
  }

  interface FastifyContextConfig {
    caffeine?: {
      hasStatus: boolean
      status: number
      hasContentType: boolean
      contentType: string
      hasHeader: boolean
      header: Array<[string, string | string[]]>
      catchBy?: CatchByMap
      /**
       * What the route declared about authentication and authorization, carried here because the
       * authentication middleware is registered once for the whole server and only learns which route it is
       * on at request time.
       */
      auth?: {
        schemes?: readonly string[]
        allowAnonymous: boolean
        authorizer?: AuthzRouteService
      }
    }
  }
}
