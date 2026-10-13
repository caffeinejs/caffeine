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
import type { ConfigDefinition } from '@caffeinejs/std/config'
import { newNoopLogger, type Logger } from '@caffeinejs/std/logger'

import { devTools, type DevToolsBuilder } from '../index.js'

export const listener = { host: '127.0.0.1', port: 0 }

/** What `authorize(...)` asks for in these tests: the Basic scheme below, and the operator role. */
export const PROTECTED = { schemes: ['devtools'], roles: ['operator'] }

export const OPERATOR = basic('ops', 'secret')
export const VIEWER = basic('viewer', 'secret')

const USERS: Record<string, string[]> = { 'ops:secret': ['operator'], 'viewer:secret': ['viewer'] }

export interface TargetOptions {
  devtools?: HTTPPluginConfigurer<DevToolsBuilder>
  container?: CaffeineIoC
  config?: ConfigDefinition<unknown>
  profiles?: string[]
  logger?: Logger
  /** Installs a Basic scheme named "devtools". */
  basic?: boolean
  /** Registers an authentication gate on the DevTools server; on whenever `basic` is. */
  gate?: boolean
}

/**
 * An application serving DevTools on an ops server named "devtools", over a container no decorated class reaches.
 */
export function target(options: TargetOptions = {}): WebApplication {
  const { basic: withBasic = false, gate = withBasic } = options

  const app = createWebApplication({
    container: options.container ?? new CaffeineIoC({ decorators: false }),
    config: options.config,
    profiles: options.profiles,
  })

  if (options.logger !== undefined) {
    const logger = options.logger
    app.logger(b => b.use(logger))
  }

  if (withBasic) {
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

      if (gate) {
        o.with(authentication())
      }

      o.with(devTools(options.devtools))
    }),
  )

  return app.server(() => ({ listener })) as WebApplication
}

/** A request to the DevTools server, in-process. */
export function get(app: WebApplication, path: string, headers?: Record<string, string>): Promise<Response> {
  return app.ops.get('devtools')!.fetch(path, { headers })
}

export function basic(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
}

/** A logger keeping the text of every warning written through it or a child of it. */
export function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  const logger: Logger = {
    ...newNoopLogger(),
    warn: ((first: unknown, second?: unknown) => {
      warnings.push(typeof first === 'string' ? first : String(second))
    }) as Logger['warn'],
    child: () => logger,
  }

  return { logger, warnings }
}

function principal(user: string, roles: readonly string[]): Principal {
  return new Principal(
    true,
    new Identity('Basic', true, [new Claim('sub', user, ''), ...roles.map(role => new Claim('roles', role, ''))]),
  )
}
