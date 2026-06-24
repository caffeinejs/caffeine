import { ParameterPickOptions } from '@caffeinejs/http'
import { FastifyRequest, FastifyReply } from 'fastify'
import { FastifyContext } from './context.js'

type Accessor<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>
  = (req: REQ, res: RES) => unknown

export function compileParameters<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(params: ParameterPickOptions<REQ>[]): (req: REQ, res: RES) => unknown[] {
  const accessors: Accessor<REQ, RES>[] = params.map(p => {
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
        return (req, res) => new FastifyContext(req, res)
      case 'method':
        return req => req.method
      case 'url':
        return req => req.url
      case 'path':
        return req => req.url.split('?')[0]
      case 'signal':
        return req => req.signal
      case 'port':
        return req => req.port
      case 'address':
        return req => req.socket.remoteAddress
      default:
        throw new Error(`Invalid parameter type: ${type}`)
    }
  })

  // Fast-path for a parameter-less route.
  if (accessors.length === 0) {
    return () => []
  }

  return (req, res) => {
    const out = new Array(accessors.length)
    for (let i = 0; i < accessors.length; i++) {
      out[i] = accessors[i](req, res)
    }

    return out
  }
}
