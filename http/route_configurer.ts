import { Route, Router } from '@caffeinejs/application'
import { FastifyInstance, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RouteGenericInterface, RouteOptions } from 'fastify'

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
