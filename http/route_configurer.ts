import { FastifyInstance, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RouteGenericInterface, RouteOptions } from 'fastify'
import type { Route, Router } from './route.js'

export interface RouteConfigurerIn<REQ extends FastifyRequest = FastifyRequest> {
  server: FastifyInstance
  router: Router<REQ>
  route: Route<REQ>
  routeDef: RouteOptions<
    RawServerBase,
    RawRequestDefaultExpression<RawServerBase>,
    RawReplyDefaultExpression<RawServerBase>,
    RouteGenericInterface,
    any
  >
}

export type RouteConfigurer
  = <REQ extends FastifyRequest = FastifyRequest>(input: RouteConfigurerIn<REQ>) => void
