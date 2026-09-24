import { type Container } from '@caffeinejs/di'

import { type FastifyContext } from './fastify_context.js'
import { type RouteGroupBuilder } from './routing/builder.js'
import { type CaffeineRouteConfig } from './routing/fastify/route_config.js'
import { type Principal } from './security/identity.js'
import { Keys } from './symbols.js'

declare module 'fastify' {
  interface FastifyInstance {
    get $container(): Container
    $route(name: string, build: (router: RouteGroupBuilder) => void): void
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
    /**
     * What Caffeine compiled for the route, and what the authentication gate does with it.
     *
     * Stamped by the adapter onto every route its server registers, so a plugin's `onRoute` hook tells a
     * compiled route from one registered straight on Fastify by {@link CaffeineRouteConfig.compiled}, not by
     * this field's presence.
     */
    $caffeine?: CaffeineRouteConfig
  }
}
