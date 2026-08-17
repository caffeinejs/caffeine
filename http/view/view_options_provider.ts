import { kServiceConfigure, type Service } from '@caffeinejs/std'
import { ErrConfiguration } from '../error/common.js'
import type { ServiceKit } from '../service.js'
import { kViewOptionsProvider } from './keys.js'
import { ViewBuilder } from './view_builder.js'
import type { ViewOptions } from './view.js'

/**
 * Groups every configured view engine — the default one (`reply.view`) plus any named ones
 * (`reply.<name>`) — behind a single DI binding. `app.view(name?, configure)` routes each call here to
 * get-or-create the matching {@link ViewBuilder}; {@link ViewConfigurer} reads the provider back and
 * registers `@fastify/view` once per {@link all} entry.
 */
export class ViewOptionsProvider implements Service {
  // Keyed by engine name; the `undefined` key is the default engine.
  readonly #builders = new Map<string | undefined, ViewBuilder>()

  /**
   * Returns the {@link ViewBuilder} for the given engine name, creating it on first use. Repeated calls
   * for the same name return the same builder, so configuration merges (mirrors the single-engine
   * "call `app.view` twice" behavior). The name `"view"` is reserved for the default engine.
   */
  builder(name: string | undefined): ViewBuilder {
    if (name === 'view') {
      throw new ErrConfiguration('Cannot register a view engine named "view": it is reserved for the default engine')
    }

    let builder = this.#builders.get(name)
    if (builder == null) {
      builder = new ViewBuilder(name)
      this.#builders.set(name, builder)
    }

    return builder
  }

  /** The assembled options for the default engine, or `undefined` when only named engines are configured. */
  default(): ViewOptions | undefined {
    return this.#builders.get(undefined)?.build()
  }

  /** Every engine's assembled options, the default (if any) first, then the named ones in insertion order. */
  all(): ViewOptions[] {
    const out: ViewOptions[] = []
    for (const [name, builder] of this.#builders) {
      if (name === undefined) {
        out.push(builder.build())
      }
    }
    for (const [name, builder] of this.#builders) {
      if (name !== undefined) {
        out.push(builder.build())
      }
    }

    return out
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    // Eagerly validate every registration (each build() throws when its engine is missing) before the
    // container initializes.
    void this.all()

    kit.container.bind(kViewOptionsProvider).toValue(this).internal()

    return Promise.resolve()
  }
}
