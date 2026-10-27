import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Logger } from '@caffeinejs/application/logger'
import { assertLoopbackHost } from '@caffeinejs/devtools'
import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { html } from '@caffeinejs/html'
import { createWebApplication, csrf, healthProbes } from '@caffeinejs/http/fastify'
import { staticFiles } from '@caffeinejs/static'

import { DevToolsAPI } from './api.js'
import { configuration, kConfig } from './app.config.js'
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
      // A page on another site that resolves its name to this loopback address is refused: it would read the devtools
      // with the credentials this UI holds.
      .use((ctx, next) => {
        assertLoopbackHost(ctx)
        return next()
      })
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
