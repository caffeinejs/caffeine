import { ErrConfiguration, registerPlugin } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'

import { ViewEngineBuilder } from './engine_builder.js'
import type { ViewOptions } from './view.js'
import { viewPlugin } from './view_plugin.js'

/** Reserved: `reply.view` is the default engine's decoration, so a named engine cannot claim it. */
const RESERVED_ENGINE_NAME = 'view'

/**
 * Configures server-side rendering over `@fastify/view`.
 *
 * One feature holds every engine: the default one, decorating `reply.view`, plus any named ones decorating
 * `reply.<name>`. The plugin it contributes registers `@fastify/view` once per configured engine.
 *
 * ```ts
 * .extend(view((v, c) => {
 *   v.engine(e => e.engine({ handlebars }).withConfig(c.app.templates))
 *   v.engine('mail', e => e.engine({ handlebars }).root('emails'))
 * }))
 * ```
 */
export class ViewBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'view'

  // Keyed by engine name; the `undefined` key is the default engine.
  readonly #engines = new Map<string | undefined, ViewEngineBuilder>()

  /** Configures the default engine, decorating `reply.view`. */
  engine(configure: (engine: ViewEngineBuilder) => void): this
  /** Configures a named engine, decorating `reply.<name>`. */
  engine(name: string, configure: (engine: ViewEngineBuilder) => void): this
  engine(
    nameOrConfigure: string | ((engine: ViewEngineBuilder) => void),
    maybeConfigure?: (engine: ViewEngineBuilder) => void,
  ): this {
    const name = typeof nameOrConfigure === 'string' ? nameOrConfigure : undefined
    const configure = typeof nameOrConfigure === 'string' ? maybeConfigure : nameOrConfigure

    if (name === RESERVED_ENGINE_NAME) {
      throw new ErrConfiguration(
        `Cannot register a view engine named "${RESERVED_ENGINE_NAME}": it is reserved for the default engine`,
      )
    }

    if (this.#engines.has(name)) {
      throw new ErrConfiguration(
        `Cannot register view engine "${name ?? 'default'}": an engine with that name is already configured`,
      )
    }

    const builder = new ViewEngineBuilder(name)
    configure?.(builder)
    this.#engines.set(name, builder)

    return this
  }

  /** The assembled options for the default engine, or `undefined` when only named engines are configured. */
  default(): ViewOptions | undefined {
    return this.#engines.get(undefined)?.build()
  }

  /** Every engine's assembled options, the default (if any) first, then the named ones in insertion order. */
  all(): ViewOptions[] {
    const out: ViewOptions[] = []

    for (const [name, builder] of this.#engines) {
      if (name === undefined) {
        out.push(builder.build())
      }
    }
    for (const [name, builder] of this.#engines) {
      if (name !== undefined) {
        out.push(builder.build())
      }
    }

    return out
  }

  protected bootstrap(kit: BootstrapKit<C>): void {
    if (this.#engines.size === 0) {
      throw new ErrConfiguration(
        'Cannot install the view feature: no engine was configured. Call .engine(...) on the builder',
      )
    }

    // Forces every engine to assemble now, so a missing engine module fails at start-up rather than from
    // inside the plugin, by which point the adapter is already wiring routes.
    this.all()

    // The builder goes to the plugin directly rather than through a container key it would only be read back
    // out of at server setup.
    registerPlugin(kit, viewPlugin(this))
  }
}
