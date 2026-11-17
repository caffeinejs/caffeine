import type { ParameterPickOptions } from '@caffeinejs/application/framework'

import { compileArgsWith, compileHandlerWith } from '../routing/parameters.js'
import type { IRouteCompilers } from '../routing/route.js'
import type { Context } from './context.js'
import { configurationError } from './error.js'

type Picker = (ctx: Context) => unknown

/**
 * The parameter compilers of the engine, routes compiled against its Context. `res` is opaque to a route source, so
 * each compiled function is re-typed here.
 */
export const engineCompilers: IRouteCompilers<Context> = {
  handler: (parameters, fn) =>
    compileHandlerWith<Context, unknown>(parameters, fn, basePicker) as (req: Context, res: unknown) => unknown,
  args: parameters =>
    compileArgsWith<Context, unknown>(parameters, basePicker) as (
      req: Context,
      res: unknown,
    ) => unknown[] | Promise<unknown[]>,
}

/** The port `host` names, or `null` when it names none, as Fastify's `request.port` reads it. Handles `[::1]:8080`. */
export function portOf(host: string): number | null {
  const colon = host.lastIndexOf(':')

  // An IPv6 literal's own colons sit inside its brackets.
  if (colon === -1 || colon < host.lastIndexOf(']')) {
    return null
  }

  const port = Number(host.slice(colon + 1))

  return Number.isInteger(port) && host.length > colon + 1 ? port : null
}

// What each built-in pick reads off the engine's context.
function basePicker(p: ParameterPickOptions<Context>): Picker {
  const field = p.name

  switch (p.type) {
    case 'query':
      return field ? ctx => ctx.req.query()[field] : ctx => ctx.req.query()
    case 'params':
      return field ? ctx => ctx.req.param(field) : ctx => ctx.req.param()
    case 'header':
      return field ? ctx => ctx.req.header(field) : ctx => ctx.req.header()
    case 'body':
      return ctx => ctx.req.body()
    case 'context':
      return ctx => ctx
    case 'user':
      return ctx => ctx.user
    case 'method':
      return ctx => ctx.req.method
    case 'url':
      return ctx => ctx.req.url
    case 'path':
      return ctx => {
        const url = ctx.req.url
        const i = url.indexOf('?')
        return i === -1 ? url : url.slice(0, i)
      }
    case 'signal':
      return ctx => ctx.signal
    case 'port':
      return ctx => portOf(ctx.req.host)
    case 'address':
      return ctx => ctx.remoteAddress
    case 'cookie':
      return field ? ctx => ctx.req.cookie(field) : ctx => ctx.req.cookie()
    case 'cookie:signed':
      return field ? ctx => ctx.req.signedCookie(field) : ctx => ctx.req.signedCookie()
    default:
      throw configurationError(
        `Cannot compile a parameter of type "${String(p.type)}": no picker reads it`,
        'Pick it with $p.pick(ctx => ...)',
      )
  }
}
