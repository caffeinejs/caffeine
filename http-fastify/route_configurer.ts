import { Route, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'

export interface RouteConfigurerIn<REQ extends FastifyRequest = FastifyRequest> {
  server: FastifyInstance
  router: Router<REQ>
  route: Route<REQ>
  routeDef: RouteOptions
}

export type RouteConfigurer
  = <REQ extends FastifyRequest = FastifyRequest>(input: RouteConfigurerIn<REQ>) => void
