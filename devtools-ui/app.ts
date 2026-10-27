import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Logger } from '@caffeinejs/application/logger'
import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { html } from '@caffeinejs/html'
import { ErrHTTPMisdirectedRequest, type MiddlewareFn } from '@caffeinejs/http'
import { createWebApplication, csrf, healthProbes } from '@caffeinejs/http/fastify'
import { staticFiles } from '@caffeinejs/static'

import { DevToolsAPI } from './api.js'
import { ALLOWED_HOSTS_VARIABLE, configuration, kConfig } from './app.config.js'
import { configRouter } from './config/index.js'
import { diRouter } from './di/index.js'
import { eventsRouter } from './events/index.js'
import { healthRouter } from './health/index.js'
import { homeRouter } from './home/index.js'
import { infoRouter } from './info/index.js'
import { refreshablesRouter } from './refreshables/index.js'
import { routesRouter } from './routes/index.js'
import { runtimeRouter } from './runtime/index.js'
import { PageErrorHandler, TargetErrorHandler } from './shared/errors/index.js'

// The package root, whether this runs from the sources or from `dist/`.
const here = dirname(fileURLToPath(import.meta.url))
const root = basename(here) === 'dist' ? dirname(here) : here

export interface BuildAppOptions {
  /** The container to build on; a fresh one by default. */
  container?: Container
  /** The application logger, or `false` for a silent one. Tests pass `false`. */
  logger?: Logger | false
}

/** Builds the devtools UI: a page per tool the devtools serve, read through {@link DevToolsAPI}. */
export function buildApp(options: BuildAppOptions = {}) {
  const container = options.container ?? new CaffeineIoC()

  container.bind(DevToolsAPI, t => t.toFactory(ctx => new DevToolsAPI(ctx.container.get(kConfig))))

  return (
    createWebApplication({ container, config: configuration, logger: options.logger })
      .server(({ config }) => ({ listener: config.server }))
      .logger((b, { config }) => b.level(config.log.level))
      .errorHandling(e => e.globalHandlers(PageErrorHandler, TargetErrorHandler))
      // Refuses DNS rebinding on any address, since behind a container's published port requests are not on loopback.
      .useFn(({ config }) => allowedHosts(config.allowedHosts))
      // The refresh forms change something in the application the UI reads: no other site may post them.
      .with(csrf())
      // `/livez`, `/readyz` and `/startupz`, for an orchestrator: they say whether the UI serves, whatever the devtools
      // it reads answer.
      .with(healthProbes())
      .with(() => html())
      .with(staticFiles(s => s.serve(join(root, 'public'), { prefix: '/static' })))
      .mount(
        homeRouter,
        infoRouter,
        healthRouter,
        diRouter,
        configRouter,
        routesRouter,
        refreshablesRouter,
        eventsRouter,
        runtimeRouter,
      )
  )
}

// An orchestrator probes the address it reached the container on, and a probe answers nothing a page could read.
const PROBES = new Set(['/livez', '/readyz', '/startupz'])

function allowedHosts(names: readonly string[]): MiddlewareFn {
  const allowed = new Set(names.map(name => name.toLowerCase()))

  return (ctx, next) => {
    const host = ctx.req.host
    const name = hostname(host)

    if (!isLoopback(name) && !allowed.has(name) && !PROBES.has(ctx.req.url.split('?', 1)[0]!)) {
      throw new ErrHTTPMisdirectedRequest(
        `Cannot answer for host "${host}": this UI answers loopback names and those ${ALLOWED_HOSTS_VARIABLE} lists alone`,
      )
    }

    return next()
  }
}

function isLoopback(name: string): boolean {
  return name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name)
}

function hostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return ''
  }
}
