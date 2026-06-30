import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterIn, Router } from '@caffeinejs/http'
import { Context, Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import {
  compileHandler,
  setParsedBody,
  setParsedMultipart,
  type MultipartData,
} from './adapter_handler_parameters.js'
import { type HonoAdapterOptions } from './adapter_factory.js'
import { PENDING_RESPONSE } from './context.js'

export class HonoAdapter<
  SERVER extends Hono = Hono,
  CTX extends Context = Context,
> implements Adapter<SERVER, CTX> {
  #hono: SERVER
  #container: Container
  #options: HonoAdapterOptions | undefined

  constructor(container: Container, hono: SERVER, options?: HonoAdapterOptions) {
    this.#hono = hono
    this.#container = container
    this.#options = options
  }

  async setup(input: AdapterIn<CTX>): Promise<void> {
    const routers = input.routers as Router<CTX>[]

    const needsRequestScope = routers.some(
      router => this.#container.hasScopeInGraph(router.key, Scopes.REQUEST),
    )

    if (needsRequestScope) {
      const man = this.#container.requestScopeManager
      this.#hono.use('*', async (_c, next) => {
        await man.run(() => next())
      })
    }

    for (let i = 0; i < routers.length; i++) {
      const router = routers[i]
      const basePath = router.path
      const routes = router.routes
      const sub = new Hono()
      const controller = router.controller
      const isSingleton = router.binding.scopeId === Scopes.SINGLETON

      const cookieSecret = this.#options?.cookies?.secret
      const adapterConfig = cookieSecret ? { cookieSecret } : undefined

      for (const route of routes) {
        let dispatch: (c: CTX) => unknown

        if (isSingleton) {
          const ref = controller.get()
          const refFn = (ref[route.handler] as (...args: unknown[]) => unknown).bind(ref)
          dispatch = compileHandler(route.parameters, refFn, adapterConfig)
        } else {
          const handlerKey = route.handler
          dispatch = compileHandler(route.parameters, (...args) => {
            const inst = controller.get()
            return (inst[handlerKey] as (...args: unknown[]) => unknown).apply(inst, args)
          }, adapterConfig)
        }

        const path = joinPaths(basePath, route.path)
        const needsBody = route.parameters.some(p => p.type === 'body')
        const needsMultipart = route.parameters.some(p => p.type.startsWith('multipart:'))

        const handler = async (c: Context): Promise<Response> => {
          if (router.header) {
            for (const [k, v] of router.header) {
              setResponseHeader(c, k, v)
            }
          }

          if (route.header) {
            for (const [k, v] of route.header) {
              setResponseHeader(c, k, v)
            }
          }

          if (route.contentType) {
            c.header('content-type', route.contentType)
          }

          if (route.statusCode !== undefined) {
            c.status(route.statusCode as StatusCode)
          }

          if (needsBody) {
            const contentType = c.req.header('content-type') ?? ''
            if (contentType.includes('application/json')) {
              setParsedBody(c, await c.req.json())
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
              setParsedBody(c, await c.req.parseBody())
            } else {
              setParsedBody(c, await c.req.text())
            }
          }

          if (needsMultipart) {
            setParsedMultipart(c, await c.req.parseBody({ all: true }) as MultipartData)
          }

          const result = await dispatch(c as CTX)

          return respond(result, c, route.contentType)
        }

        for (const method of [...new Set(route.method.map(m => m.toUpperCase()))]) {
          sub.on(method, path, handler)
        }
      }

      this.#hono.route(router.prefix ?? '', sub)
    }
  }

  async teardown(): Promise<void> {
    // Hono has no lifecycle teardown
  }

  get instance(): SERVER {
    return this.#hono
  }

  async fetch(input: string | URL | Request, options?: RequestInit): Promise<Response> {
    let request: Request

    if (input instanceof Request) {
      request = input
    } else {
      let url = input
      if (typeof url === 'string' && url.startsWith('/')) {
        url = 'http://localhost' + url
      }
      request = new Request(url, options)
    }

    return this.#hono.fetch(request)
  }
}

function respond(result: unknown, c: Context, contentType?: string): Response {
  const pending = (c as Context & { [PENDING_RESPONSE]?: Response })[PENDING_RESPONSE]
  if (pending) {
    return pending
  }

  if (result instanceof Response) {
    return result
  }

  if (result === undefined) {
    return c.body(null, c.res.status as StatusCode)
  }

  if (contentType === 'text/plain') {
    return c.text(String(result))
  }

  return c.json(result)
}

function setResponseHeader(c: Context, key: string, value: string | string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) {
      c.header(key, v)
    }
    return
  }

  c.header(key, value)
}

function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}
