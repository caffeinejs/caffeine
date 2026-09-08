import type { AbstractCtor, Container, InjectionToken } from '@caffeinejs/di'

/** The least an extension is handed: the resolved container. A platform widens it with its own handles. */
export interface ExtensionIn {
  container: Container
}

/**
 * A unit of start-up wiring one feature contributes and the platform runs.
 *
 * Bind the implementation under its own key, then hand that key to `kit.extensions.add(...)` — binding alone
 * registers nothing.
 */
export interface Extension<T extends ExtensionIn = ExtensionIn> {
  /** Identifies the extension to the platform, and to another extension's {@link dependencies}. */
  readonly name: string

  /** Extension names that must already have run. Asserted by the platform, never reordered. */
  readonly dependencies?: readonly string[]

  configure(ctx: T): void | Promise<void>
}

/** What a feature may do with the registry while it bootstraps: add its own extension key. */
export interface ExtensionRegistrar {
  add<E extends Extension<ExtensionIn>>(extension: InjectionToken<E>): void
}

interface ExtensionEntry {
  order: number
  token: InjectionToken<Extension<ExtensionIn>>
}

/**
 * The application's extension registry: injection keys, kept in feature-install order.
 *
 * Features bootstrap concurrently, so what a feature adds is stamped with its position in the application's
 * feature list rather than with the moment it got there — an `await` before the `add` does not move it.
 *
 * {@link of} resolves through the container, so it may only be called once the container has initialized: the
 * platform's `setup()` step, never a feature's `bootstrap`.
 */
export class Extensions {
  readonly #container: Container
  readonly #entries: ExtensionEntry[] = []

  constructor(container: Container) {
    this.#container = container
  }

  /** The registrar for the feature at `order`. Everything it adds sorts at that position. */
  at(order: number): ExtensionRegistrar {
    return {
      add: extension => {
        this.#entries.push({ order, token: extension as InjectionToken<Extension<ExtensionIn>> })
      },
    }
  }

  /** Every registered extension that is an instance of `base`, in feature-install order. */
  of<T extends Extension<ExtensionIn>>(base: AbstractCtor<T>): T[] {
    // Stable sort, so two extensions added by the same feature keep the order that feature added them in.
    const ordered = [...this.#entries].sort((a, b) => a.order - b.order)
    const found: T[] = []

    for (const entry of ordered) {
      const extension = this.#container.get(entry.token)
      if (extension instanceof base) {
        found.push(extension)
      }
    }

    return found
  }
}
