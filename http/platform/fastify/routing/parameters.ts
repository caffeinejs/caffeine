import type { ParameterPickOptions } from '@caffeinejs/application/framework'
import { FastifyRequest, FastifyReply } from 'fastify'

import { compileArgsWith, compileHandlerWith } from '../../../core/routing/parameters.js'

type Picker<REQ extends FastifyRequest = FastifyRequest, RES extends FastifyReply = FastifyReply> = (
  req: REQ,
  res: RES,
) => unknown

// Compiles the parameter pickers into a function that returns the handler's argument list. Unlike
// compileHandler, it does not bake in the target function — the caller resolves the instance and
// invokes the method itself, so the same instance can be reused (e.g. for per-controller error
// handling of transient-scoped controllers).
export function compileArgs<REQ extends FastifyRequest = FastifyRequest, RES extends FastifyReply = FastifyReply>(
  params: ParameterPickOptions<REQ>[],
): (req: REQ, res: RES) => unknown[] | Promise<unknown[]> {
  return compileArgsWith<REQ, RES>(params, buildBasePicker)
}

export function compileHandler<REQ extends FastifyRequest = FastifyRequest, RES extends FastifyReply = FastifyReply>(
  params: ParameterPickOptions<REQ>[],
  fn: (...args: unknown[]) => unknown,
): (req: REQ, res: RES) => unknown {
  return compileHandlerWith<REQ, RES>(params, fn, buildBasePicker)
}

function buildBasePicker<REQ extends FastifyRequest = FastifyRequest, RES extends FastifyReply = FastifyReply>(
  p: ParameterPickOptions<REQ>,
): Picker<REQ, RES> {
  const type = p.type
  const field = p.name

  switch (type) {
    case 'body':
      return req => req.body
    case 'query':
      if (field) {
        return req => (req.query as Record<string, unknown>)[field]
      } else {
        return req => req.query
      }
    case 'params':
      if (field) {
        return req => (req.params as Record<string, unknown>)[field]
      } else {
        return req => req.params
      }
    case 'header':
      if (field) {
        return req => (req.headers as Record<string, unknown>)[field]
      } else {
        return req => req.headers
      }
    case 'context':
      return req => req.httpContext
    case 'user':
      return req => req.httpContext.user
    case 'method':
      return req => req.method
    case 'url':
      return req => req.url
    case 'path':
      return req => {
        const i = req.url.indexOf('?')
        return i === -1 ? req.url : req.url.slice(0, i)
      }
    // The context's, not Fastify's: see `Context.signal`.
    case 'signal':
      return req => req.httpContext.signal
    case 'port':
      return req => req.port
    case 'address':
      return req => req.socket.remoteAddress
    // Through the request's context, which parses the cookies once and signs and verifies with the server's signer.
    case 'cookie':
      if (field) {
        return req => req.httpContext.req.cookie(field)
      }
      return req => req.httpContext.req.cookie()
    case 'cookie:signed':
      if (field) {
        return req => req.httpContext.req.signedCookie(field)
      }
      return req => req.httpContext.req.signedCookie()
    case 'fastify:request':
      return req => req
    case 'fastify:reply':
      return (_req, res) => res
    default:
      throw new Error(`Invalid parameter type: ${type}`)
  }
}
