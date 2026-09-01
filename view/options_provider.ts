import { type ServiceBeforeBootstrapIn, type Service, ServiceBootstrapIn } from '@caffeinejs/std'
import { ErrConfiguration } from '@caffeinejs/http'
import { ViewBuilder } from './builder.js'
import { ViewExtension } from './extension.js'
import type { ViewOptions } from './view.js'

/**
 * Groups every configured view engine — the default one (`reply.view`) plus any named ones
 * (`reply.<name>`) — behind a single object. `app.view(name?, configure)` routes each call here to
 * get-or-create the matching {@link ViewBuilder}; the {@link ViewExtension} it hands itself to registers
 * `@fastify/view` once per {@link all} entry.
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

  get name(): string {
    return 'view'
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    // Registers each engine's slice, and validates it while doing so — `register` throws when no engine was
    // configured, which has to surface here rather than from `build()`: by the time anything builds, the
    // adapter is already wiring routes.
    for (const builder of this.#builders.values()) {
      builder.register(kit.config)
    }
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    // Self-register the extension so the adapter discovers it via getManyOptional(ServerExtension)
    // and registers it as a Fastify plugin — http no longer hardcodes it. The provider goes in directly
    // rather than through a container key it would only be read back out of at server setup.
    kit.container.bind(ViewExtension).toValue(new ViewExtension(this)).extends()

    return Promise.resolve()
  }
}
