import { ParameterPickOptions } from '@caffeinejs/http'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { FastifyContext } from './context.js'

type Accessor<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>
  = (server: SERVER, req: REQ, res: RES) => unknown

export function compileParameters<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(params: ParameterPickOptions<REQ>[]): (server: SERVER, req: REQ, res: RES) => unknown[] {
  const accessors: Accessor[] = params.map(p => {
    const type = p.type
    const field = p.name

    switch (type) {
      case 'body':
        return (_server, req, _res) => req.body
      case 'query':
        if (field) {
          return (_server, req, _res) => (req.query as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.query
        }
      case 'params':
        if (field) {
          return (_server, req, _res) => (req.params as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.params
        }
      case 'header':
        if (field) {
          return (_server, req, _res) => (req.headers as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.headers
        }
      case 'context':
        return (_server, req, res) => new FastifyContext(req, res)
      case 'method':
        return (_server, req, _res) => req.method
      case 'url':
        return (_server, req, _res) => req.url
      case 'path':
        return (_server, req, _res) => req.url.split('?')[0]
      case 'signal':
        return (_server, req, _res) => req.signal
      case 'port':
        return (_server, req, _res) => req.port
      case 'address':
        return (_server, req, _res) => req.socket.remoteAddress
      default:
        throw new Error(`Invalid parameter type: ${type}`)
    }
  })

  // Fast-path for a parameter-less route.
  if (accessors.length === 0) {
    return () => []
  }

  return (server, req, res) => {
    const out = new Array(accessors.length)
    for (let i = 0; i < accessors.length; i++) {
      out[i] = accessors[i](server, req, res)
    }

    return out
  }
}
