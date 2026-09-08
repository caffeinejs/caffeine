import { ErrConfiguration } from '@caffeinejs/http'
import {
  kBeforeBootstrap,
  kBootstrap,
  kFeatureName,
  type BeforeBootstrapKit,
  type BootstrapKit,
  type FeatureLifecycle,
} from '@caffeinejs/std'

import { ViewBuilder } from './builder.js'
import { ViewExtension } from './extension.js'
import type { ViewOptions } from './view.js'

/**
 * Groups every configured view engine — the default one (`reply.view`) plus any named ones
 * (`reply.<name>`) — behind a single object. Each `.extend(ViewExt, …)` / `.extend(ViewExt('mail'), …)`
 * adds one {@link ViewBuilder}; the {@link ViewExtension} it hands itself to registers `@fastify/view`
 * once per {@link all} entry.
 */
export class ViewOptionsProvider implements FeatureLifecycle {
  readonly [kFeatureName] = 'view'

  // Keyed by engine name; the `undefined` key is the default engine.
  readonly #builders = new Map<string | undefined, ViewBuilder>()

  /**
   * Records a configured engine. Duplicate identities throw rather than overwrite. The name `"view"` is
   * rejected by {@link ViewExt}.
   */
  add(builder: ViewBuilder): void {
    const name = builder.engineName
    if (this.#builders.has(name)) {
      throw new ErrConfiguration(
        `Cannot register view engine "${name ?? 'default'}": an engine with that name is already configured`,
      )
    }

    this.#builders.set(name, builder)
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

  [kBeforeBootstrap](kit: BeforeBootstrapKit): void {
    // Registers each engine's slice, and validates it while doing so — `register` throws when no engine
    // was configured, which has to surface here rather than from `build()`: by the time anything builds,
    // the adapter is already wiring routes.
    for (const builder of this.#builders.values()) {
      builder.register(kit.config)
    }
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    // Registered with the application's extensions, so the adapter runs it as a Fastify plugin. The provider
    // goes in directly rather than through a container key it would only be read back out of at server setup.
    kit.extensions.register(ViewExtension, new ViewExtension(this))

    return Promise.resolve()
  }
}
