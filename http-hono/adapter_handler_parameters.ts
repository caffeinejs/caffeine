import { ParameterPickOptions } from '@caffeinejs/http'
import { Context } from 'hono'
import { HonoContext, HonoContextHolder } from './context.js'

const PARSED_BODY = Symbol('parsedBody')
const CONTEXT_HOLDER = Symbol('contextHolder')

type Picker<CTX extends Context = Context> = (c: CTX) => unknown

export function setParsedBody(c: Context, body: unknown): void {
  ; (c as Context & { [PARSED_BODY]: unknown })[PARSED_BODY] = body
}

export function getParsedBody(c: Context): unknown {
  return (c as Context & { [PARSED_BODY]?: unknown })[PARSED_BODY]
}

export function getContextHolder(c: Context): HonoContextHolder | undefined {
  return (c as Context & { [CONTEXT_HOLDER]?: HonoContextHolder })[CONTEXT_HOLDER]
}

export function compileHandler<
  CTX extends Context = Context,
>(
  params: ParameterPickOptions<CTX>[],
  fn: (...args: unknown[]) => unknown,
): (c: CTX) => unknown {
  if (params.length === 0) {
    return () => fn()
  }

  const a = params.map(p => buildPicker<CTX>(p))
  const hasAsync = params.some(p => p.async === true)

  if (!hasAsync) {
    switch (a.length) {
      case 1:
        return c =>
          fn(a[0](c))
      case 2:
        return c =>
          fn(a[0](c), a[1](c))
      case 3:
        return c =>
          fn(a[0](c), a[1](c), a[2](c))
      case 4:
        return c =>
          fn(a[0](c), a[1](c), a[2](c), a[3](c))
      case 5:
        return c =>
          fn(a[0](c), a[1](c), a[2](c), a[3](c), a[4](c))
      case 6:
        return c =>
          fn(a[0](c), a[1](c), a[2](c), a[3](c), a[4](c), a[5](c))
      default: {
        const len = a.length
        return c => {
          const out = new Array(len)
          for (let i = 0; i < len; i++) {
            out[i] = a[i](c)
          }
          return fn(...out)
        }
      }
    }
  }

  switch (a.length) {
    case 1:
      return c =>
        Promise.all([a[0](c)]).then(r => fn(r[0]))
    case 2:
      return c =>
        Promise.all([a[0](c), a[1](c)]).then(r => fn(r[0], r[1]))
    case 3:
      return c =>
        Promise.all([a[0](c), a[1](c), a[2](c)]).then(r => fn(r[0], r[1], r[2]))
    case 4:
      return c =>
        Promise.all([a[0](c), a[1](c), a[2](c), a[3](c)]).then(r => fn(r[0], r[1], r[2], r[3]))
    case 5:
      return c =>
        Promise.all([a[0](c), a[1](c), a[2](c), a[3](c), a[4](c)]).then(r => fn(r[0], r[1], r[2], r[3], r[4]))
    case 6:
      return c =>
        Promise.all([a[0](c), a[1](c), a[2](c), a[3](c), a[4](c), a[5](c)])
          .then(r => fn(r[0], r[1], r[2], r[3], r[4], r[5]))
    default: {
      const len = a.length
      return c => {
        const out = new Array(len)
        for (let i = 0; i < len; i++) {
          out[i] = a[i](c)
        }
        return Promise.all(out).then(args => fn(...args))
      }
    }
  }
}

function buildPicker<CTX extends Context = Context>(
  p: ParameterPickOptions<CTX>,
): Picker<CTX> {
  if (p.picker) {
    return c => (p.picker as (c: CTX) => unknown)(c)
  }

  const type = p.type
  const field = p.name

  switch (type) {
    case 'body':
      return c => getParsedBody(c)
    case 'query':
      if (field) {
        return c => c.req.query(field)
      } else {
        return c => c.req.query()
      }
    case 'params':
      if (field) {
        return c => c.req.param(field)
      } else {
        return c => c.req.param()
      }
    case 'header':
      if (field) {
        return c => c.req.header(field)
      } else {
        return c => c.req.header()
      }
    case 'context': {
      return c => {
        const holder: HonoContextHolder = {}
          ; (c as unknown as Context & { [CONTEXT_HOLDER]?: HonoContextHolder })[CONTEXT_HOLDER] = holder
        return new HonoContext(c, holder)
      }
    }
    case 'method':
      return c => c.req.method
    case 'url':
      return c => c.req.url
    case 'path':
      return c => c.req.path
    case 'signal':
      return c => c.req.raw.signal
    case 'port':
      return c => (c.req.raw as { socket?: { localPort?: number } }).socket?.localPort ?? null
    case 'address':
      return c => (c.req.raw as { socket?: { remoteAddress?: string } }).socket?.remoteAddress
    case 'multipart:parts':
    case 'multipart:files':
    case 'multipart:file':
      throw new Error(`Multipart is not supported by the Hono adapter: ${type}`)
    default:
      throw new Error(`Invalid parameter type: ${type}`)
  }
}
