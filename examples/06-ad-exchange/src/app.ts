import { AsyncLocalStorage } from 'node:async_hooks'

import type { ConfigDefinition } from '@caffeinejs/application/config'
import type { Logger } from '@caffeinejs/application/logger'
import type { Container } from '@caffeinejs/di'
import { createWebApplication, healthProbes } from '@caffeinejs/http/fastify'
import { Resilience } from '@caffeinejs/resilience/aop'
import { Millisecond, Second } from '@caffeinejs/std/duration'

import { type Config, configuration, WIN_NOTICE } from './app.config.js'
import { createLogger } from './app.log.js'
import { retryWinNotice } from './wins/win.notifier.js'

export interface BuildAppOptions {
  /** The application logger, or `false` for a silent one. Tests pass `false`. */
  logger?: Logger | false
  /** The configuration to start with. Tests add a source of their own, which lists the fake DSPs they start. */
  config?: ConfigDefinition<Config>
}

/**
 * Builds the web application from a given container: it never creates one, so tests can pass their own.
 *
 * Every DSP is a resilience preset named after its id. The code says which policies a DSP has; the options come from
 * `resilience` in the configuration, its `defaults` for every DSP and its `presets` for one.
 */
export function buildApp(container: Container, options: BuildAppOptions = {}) {
  return (
    createWebApplication({
      container,
      config: options.config ?? configuration,
      logger: options.logger ?? createLogger(),
    })
      .server(({ config }) => ({ listener: config.server }))
      .logger((b, { config }) => b.level(config.log.level))
      // The drain delay covers the routing-table lag while requests keep being served; tests need none.
      .shutdown(s => {
        if (process.env.VITEST !== undefined) {
          s.drainDelay(0).shutdownTimeout(200 * Millisecond)
        } else {
          s.drainDelay(5 * Second)
        }
      })
      .install(
        Resilience((r, { config }) => {
          r.config(config.resilience)
            // Lets WinNotifier read each attempt's signal: nothing calls it with one.
            .context(new AsyncLocalStorage())
            // Every breaker on /readyz. None is critical: one DSP down is a missing bid, not an exchange that
            // cannot serve, and pulling the exchange out of the load balancer would lose every auction.
            .health()
          for (const dsp of config.dsps) {
            r.preset(dsp.id, p => {
              p.circuitBreaker().timeLimiter().bulkhead()
              if (dsp.qps !== undefined) {
                p.rateLimiter({ limitForPeriod: dsp.qps })
              }
            })
          }
          // The retry's other options come from the configuration; which errors to retry is code.
          r.preset(WIN_NOTICE, p => p.retry({ retryOn: retryWinNotice }))
        }),
      )
      // Kubernetes probes: /livez, /readyz, /startupz.
      .with(healthProbes())
  )
}

/** The application's type, routes included. */
export type AdExchangeApp = ReturnType<typeof buildApp>
