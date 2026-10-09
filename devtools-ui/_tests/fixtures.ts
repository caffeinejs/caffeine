import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import { devTools, type DevToolsBuilder } from '@caffeinejs/devtools'
import { CaffeineIoC } from '@caffeinejs/di'
import {
  Authentication,
  Claim,
  Identity,
  Ops,
  Principal,
  authentication,
  createWebApplication,
  type HTTPPluginConfigurer,
  type WebApplication,
} from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { ConfigDefinition } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'

import { createDevToolsUI } from '../index.js'

const listener = { host: '127.0.0.1', port: 0 }

/** What `authorize(...)` asks for on a target that installs Basic: the scheme, and the operator role. */
export const PROTECTED = { schemes: ['devtools'], roles: ['operator'] }

const USERS: Record<string, string[]> = { 'ops:secret': ['operator'], 'viewer:secret': ['viewer'] }

export interface TargetOptions {
  /** Where DevTools answers on the target: `/devtools` unless given. */
  path?: string
  devtools?: HTTPPluginConfigurer<DevToolsBuilder>
  container?: CaffeineIoC
  /** What `caffeine.name` says. */
  name?: string
  /** The target's configuration; `name` is ignored when given. */
  config?: ConfigDefinition<unknown>
  /** Installs a Basic scheme named "devtools" and a gate on the DevTools server. */
  basic?: boolean
  /** Mounts, binds or installs whatever else the target needs, before it runs. */
  configure?: (app: WebApplication) => void
}

export interface Target {
  readonly app: WebApplication
  /** Where the target's DevTools index answers. */
  readonly url: string
}

/** A running application serving DevTools on an ops server, each on a port of its own. */
export async function startTarget(options: TargetOptions = {}): Promise<Target> {
  const config =
    options.config ??
    (options.name === undefined
      ? undefined
      : newConfiguration($t.Object({}))
          .source(new InlineConfigSource({ caffeine: { name: options.name } }))
          .build().config)

  const app = createWebApplication({
    container: options.container ?? new CaffeineIoC({ decorators: false }),
    config,
    logger: false,
  }) as WebApplication

  if (options.basic === true) {
    app.install(
      Authentication(a =>
        a.addBasic('devtools', b =>
          b.validate((_ctx, user, password) => {
            const roles = USERS[`${user}:${password}`]
            return roles === undefined ? null : principal(user, roles)
          }),
        ),
      ),
    )
  }

  app.install(
    Ops('devtools', o => {
      o.server(() => ({ listener }))

      if (options.basic === true) {
        o.with(authentication())
      }

      o.with(
        devTools((d, context) => {
          d.path(options.path ?? '/devtools')
          options.devtools?.(d, context)
        }),
      )
    }),
  )

  app.server(() => ({ listener }))
  options.configure?.(app)

  await app.run()

  const origin = app.ops.get('devtools')!.address!.origin
  const path = options.path ?? '/devtools'

  return { app, url: path === '/' ? origin : `${origin}${path}` }
}

/** The UI over the applications given, bootstrapped and ready to fetch from. */
export async function startUI(applications: Record<string, unknown>): Promise<WebApplication> {
  const ui = createDevToolsUI({ sources: [new InlineConfigSource({ applications })], logger: false })
  await ui.bootstrap()
  return ui
}

export async function page(
  ui: WebApplication,
  path: string,
): Promise<{ status: number; html: string; text: string; headers: Headers }> {
  const res = await ui.fetch(path)
  const html = await res.text()

  return { status: res.status, html, text: decode(html), headers: res.headers }
}

/** The markup with its character references decoded: what a reader sees, tags and all. */
export function decode(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** A port nothing listens on: one that was listened on, then closed. */
export async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

export interface Upstream {
  readonly url: string
  /** The headers of every request it received, in order, and the path each asked for. */
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders }>
  close(): Promise<void>
}

/** A server answering every request with `body`, recording what it was sent. Not a DevTools application. */
export async function upstream(body: string, contentType = 'application/json'): Promise<Upstream> {
  const requests: Upstream['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers })
    res.setHeader('content-type', contentType)
    res.end(body)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/devtools`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function principal(user: string, roles: readonly string[]): Principal {
  return new Principal(
    true,
    new Identity('Basic', true, [new Claim('sub', user, ''), ...roles.map(role => new Claim('roles', role, ''))]),
  )
}
