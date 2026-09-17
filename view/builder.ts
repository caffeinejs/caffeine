import { ErrConfiguration } from '@caffeinejs/http'

import { ViewEngineBuilder } from './engine_builder.js'
import { kBuild } from './keys.js'
import type { ViewOptions } from './view.js'

/** Reserved: `reply.view` is the default engine's decoration, so a named engine cannot claim it. */
const RESERVED_ENGINE_NAME = 'view'

/**
 * Configures server-side rendering over `@fastify/view`.
 *
 * One builder holds every engine: the default one, decorating `reply.view`, plus any named ones decorating
 * `reply.<name>`. The plugin it materializes registers `@fastify/view` once per configured engine.
 *
 * ```ts
 * .with(view(v => {
 *   v.add(e => e.engine({ handlebars }).root('templates'))
 *   v.add('mail', e => e.engine({ handlebars }).root('emails'))
 * }))
 * ```
 */
export class ViewBuilder {
  // Keyed by engine name; the `undefined` key is the default engine.
  readonly #engines = new Map<string | undefined, ViewEngineBuilder>()

  /** Adds the default engine, decorating `reply.view`. */
  add(configure: (engine: ViewEngineBuilder) => void): this
  /** Adds a named engine, decorating `reply.<name>`. */
  add(name: string, configure: (engine: ViewEngineBuilder) => void): this
  add(
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
    return this.#engines.get(undefined)?.[kBuild]()
  }

  /** Every engine's assembled options, the default (if any) first, then the named ones in insertion order. */
  [kBuild](): ViewOptions[] {
    const out: ViewOptions[] = []

    for (const [name, builder] of this.#engines) {
      if (name === undefined) {
        out.push(builder[kBuild]())
      }
    }
    for (const [name, builder] of this.#engines) {
      if (name !== undefined) {
        out.push(builder[kBuild]())
      }
    }

    return out
  }
}
