import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterIn, Router } from '@caffeinejs/http'
import { Context, Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import {
  compileHandler,
  getContextHolder,
  setParsedBody,
  setParsedMultipart,
  type MultipartData,
} from './adapter_handler_parameters.js'

export class HonoAdapter<
  SERVER extends Hono = Hono,
  CTX extends Context = Context,
> implements Adapter<SERVER, CTX> {
  #hono: SERVER
  #container: Container

  constructor(container: Container, hono: SERVER) {
    this.#hono = hono
    this.#container = container
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

      for (const route of routes) {
        let dispatch: (c: CTX) => unknown

        if (isSingleton) {
          const ref = controller.get()
          const refFn = (ref[route.handler] as (...args: unknown[]) => unknown).bind(ref)
          dispatch = compileHandler(route.parameters, refFn)
        } else {
          const handlerKey = route.handler
          dispatch = compileHandler(route.parameters, (...args) => {
            const inst = controller.get()
            return (inst[handlerKey] as (...args: unknown[]) => unknown).apply(inst, args)
          })
        }

        const path = joinPaths(basePath, route.path)
        const hasAsync = route.parameters.some(p => p.async === true)
        const needsBody = route.parameters.some(p => p.type === 'body')
        const needsContext = route.parameters.some(p => p.type === 'context')
        const needsMultipart = route.parameters.some(p => p.type.startsWith('multipart:'))
        const needsAsync = hasAsync || needsBody || needsMultipart

        let handler: (c: Context) => Response | Promise<Response>

        if (needsAsync) {
          handler = async (c: Context) => {
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
            return respond(result, c, route.contentType, needsContext)
          }
        } else {
          handler = (c: Context) => {
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

            const result = dispatch(c as CTX)
            if (result instanceof Promise) {
              return result.then(r => respond(r, c, route.contentType, needsContext))
            }
            return respond(result, c, route.contentType, needsContext)
          }
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

  server(): SERVER {
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

function respond(
  result: unknown,
  c: Context,
  contentType?: string,
  needsContext = false,
): Response {
  if (needsContext) {
    const holder = getContextHolder(c)
    if (holder?.response) {
      return holder.response
    }
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
