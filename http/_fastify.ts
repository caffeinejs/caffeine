import { type Container } from '@caffeinejs/di'

import { type FastifyContext } from './context.js'
import { type CatchByMap, type RouteGroup } from './route.js'
import { type AuthzRouteService } from './security/authz/route_service.js'
import { type Principal } from './security/identity.js'
import { Keys } from './symbols.js'

declare module 'fastify' {
  interface FastifyInstance {
    get $container(): Container
    get $routeGroups(): RouteGroup<FastifyRequest>[]
  }

  interface FastifyRequest {
    httpContext: FastifyContext
    routeTarget: Record<string | symbol, (...args: unknown[]) => unknown> | null
    user: Principal
  }

  interface RawRequest {
    [Keys.CONTEXT]: FastifyContext
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
       * authentication hook is added once for the whole server and only learns which route it is on at
       * request time.
       */
      auth?: {
        schemes?: readonly string[]
        allowAnonymous: boolean
        authorizer?: AuthzRouteService
      }
      /**
       * The class that declared the route and the handler's name, so a Guard can read `Symbol.metadata`
       * without a Nest-style ExecutionContext. A route declared without a class carries no `target`.
       */
      target?: Function
      handler?: string | symbol
    }
  }
}
