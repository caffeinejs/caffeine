import type { ExtensionRegistrar } from '@caffeinejs/std'

import { ErrCaffeineWebApplication } from './error/common.js'
import { solutions } from './error/util.js'
import type { HTTPPlugin } from './plugin.js'

interface Entry {
  order: number
  scope: object | undefined
  plugin: HTTPPlugin
}

/**
 * The plugins the features contributed, kept in the order their features were installed.
 *
 * Features bootstrap concurrently, so an entry is stamped with its feature's position in the application's
 * feature list rather than with the moment it got here — an `await` before the registration does not move it.
 * That position is the whole ordering model: there are no bands and nothing is sorted by what a plugin is.
 *
 * A plugin carries a scope when a router or a controller registered it rather than the application. The
 * adapter registers the unscoped ones on the root server and each scoped one inside the plugin context of the
 * route group it belongs to.
 */
export class HTTPPlugins {
  readonly #entries: Entry[] = []
  #sorted = false

  /** How many plugins have been contributed so far, which is the next free order. */
  get size(): number {
    return this.#entries.length
  }

  /** The registrar for the feature at `order`, contributing into `scope`. */
  registrarFor(order: number, scope?: object): ExtensionRegistrar<HTTPPlugin> {
    return {
      register: plugin => {
        if (typeof plugin !== 'function') {
          throw new ErrCaffeineWebApplication(
            `Cannot register an HTTP extension: expected a Fastify plugin, got ${typeof plugin}` +
              solutions('Contribute a plugin function from the feature bootstrap, not the object it wires'),
            'ERR_HTTP_INVALID_PLUGIN',
          )
        }

        this.#entries.push({ order, scope, plugin })
        this.#sorted = false
      },
    }
  }

  /** What the application installed, for the root server. */
  root(): HTTPPlugin[] {
    return this.#select(undefined)
  }

  /** What `scope` — a mounted router, or a controller class — installed, for that route group's context. */
  of(scope: object): HTTPPlugin[] {
    return this.#select(scope)
  }

  #select(scope: object | undefined): HTTPPlugin[] {
    if (!this.#sorted) {
      // Stable, so two plugins the same feature contributed keep the order it contributed them in.
      this.#entries.sort((a, b) => a.order - b.order)
      this.#sorted = true
    }

    return this.#entries.filter(entry => entry.scope === scope).map(entry => entry.plugin)
  }
}
