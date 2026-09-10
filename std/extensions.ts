import type { AbstractCtor, Container, InjectionToken } from '@caffeinejs/di'

/** The least an extension is handed: the resolved container. A platform widens it with its own handles. */
export interface ExtensionIn {
  container: Container
}

/**
 * The band an extension runs in, ahead of the order its feature was installed in.
 *
 * Framework-internal, and symbol-keyed so it stays off the surface a feature authors against. An extension
 * that sets nothing is `default`, which is where everything a package outside the framework contributes
 * belongs — the framework's own wiring is what has to bracket it.
 */
export const kExtensionStage = Symbol('caffeine.extension.stage')

/**
 * `core` is start-up wiring the rest builds on: the error handler, the body parsers, the routes the framework
 * serves itself. `gate` is request gating that has to sit behind every `default` extension — after CORS, and
 * after anything a package contributed that a rejected request still needs to pass through — but ahead of the
 * `fallback` band. `fallback` is what may only run once everything else has registered — the not-found
 * handler, which needs whatever an extension decorated the server with. Everything else is `default`.
 */
export type ExtensionStage = 'core' | 'default' | 'gate' | 'fallback'

const STAGE_RANK: Record<ExtensionStage, number> = { core: 0, default: 1, gate: 2, fallback: 3 }

function stageRank(extension: Extension<ExtensionIn>): number {
  return STAGE_RANK[extension[kExtensionStage] ?? 'default']
}

/**
 * A unit of start-up wiring one feature contributes and the platform runs.
 *
 * `kit.extensions.register(token, extension)` binds the implementation and registers it in one call. Pass a
 * token alone when the feature has already bound it (a factory, `.extends(...)`, or a per-instance key).
 */
export interface Extension<T extends ExtensionIn = ExtensionIn> {
  /** Identifies the extension to the platform, and to another extension's {@link dependencies}. */
  readonly name: string

  /** Extension names that must already have run. Asserted by the platform, never reordered. */
  readonly dependencies?: readonly string[]

  /** Framework-internal. Absent means {@link ExtensionStage} `default`. */
  readonly [kExtensionStage]?: ExtensionStage

  configure(ctx: T): void | Promise<void>
}

/** What a feature may do with the registry while it bootstraps: register its own extension. */
export interface ExtensionRegistrar {
  /**
   * Registers an extension so the platform runs it at start-up.
   *
   * Pass `extension` and it is bound under `token` too — the builder is holding it right here, so the bind and
   * the registration are one act. Omit `extension` when the feature has already bound `token` itself: a
   * factory binding, a `.extends(...)` chain, or a per-instance key.
   */
  register<E extends Extension<ExtensionIn>>(token: InjectionToken<E>, extension?: E): void
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

  /** The registrar for the feature at `order`. Everything it registers sorts at that position. */
  at(order: number): ExtensionRegistrar {
    return {
      register: (token, extension) => {
        if (extension !== undefined) {
          this.#container.bind(token, t => {
            t.toValue(extension as never)
          })
        }
        this.#entries.push({ order, token: token as InjectionToken<Extension<ExtensionIn>> })
      },
    }
  }

  /**
   * Every registered extension that is an instance of `base`, in {@link ExtensionStage} order and then in
   * feature-install order.
   *
   * Resolved before it is sorted, because the stage is a property of the extension rather than of the
   * registration — a feature does not choose which band it lands in.
   */
  of<T extends Extension<ExtensionIn>>(base: AbstractCtor<T>): T[] {
    const found: Array<{ order: number; extension: T }> = []

    for (const entry of this.#entries) {
      const extension = this.#container.get(entry.token)
      if (extension instanceof base) {
        found.push({ order: entry.order, extension })
      }
    }

    // Stable, so two extensions added by the same feature in the same stage keep the order it added them in.
    found.sort((a, b) => stageRank(a.extension) - stageRank(b.extension) || a.order - b.order)

    return found.map(entry => entry.extension)
  }
}
