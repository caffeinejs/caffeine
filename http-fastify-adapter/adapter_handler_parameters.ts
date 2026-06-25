import { ParameterPickOptions } from '@caffeinejs/http'
import { FastifyRequest, FastifyReply } from 'fastify'
import { FastifyContext } from './context.js'

type Accessor<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>
  = (req: REQ, res: RES) => unknown

function buildAccessor<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(p: ParameterPickOptions<REQ>): Accessor<REQ, RES> {
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
}

export function compileHandler<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(
  params: ParameterPickOptions<REQ>[],
  fn: (...args: unknown[]) => unknown,
): (req: REQ, res: RES) => unknown {
  if (params.length === 0) {
    return () => fn()
  }

  const a = params.map(p => buildAccessor<REQ, RES>(p))

  switch (a.length) {
    case 1:
      return (req, res) =>
        fn(a[0](req, res))
    case 2:
      return (req, res) =>
        fn(a[0](req, res), a[1](req, res))
    case 3:
      return (req, res) =>
        fn(a[0](req, res), a[1](req, res), a[2](req, res))
    case 4:
      return (req, res) =>
        fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res))
    case 5:
      return (req, res) =>
        fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res))
    case 6:
      return (req, res) =>
        fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res), a[5](req, res))
    default: {
      const len = a.length
      return (req, res) => {
        const out = new Array(len)
        for (let i = 0; i < len; i++) {
          out[i] = a[i](req, res)
        }
        return fn(...out)
      }
    }
  }
}
