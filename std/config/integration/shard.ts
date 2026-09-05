import { kSelfRefresh, type SelfRefreshable } from '@caffeinejs/di'

import type { ConfigHandle } from '../accessor.js'
import { createLiveAccessors } from '../accessor.js'
import type { ConfigBootstrapResult, BootstrapOptions } from '../bootstrap.js'
import { bootstrapConfig, notifySlices, sourcesOf } from '../bootstrap.js'
import type { ConfigDiagnostics } from '../diagnostics.js'
import { createConfigDiagnostics } from '../diagnostics.js'
import { ErrConfigSlices, type ConfigSliceFailure } from '../errors.js'
import type { ConfigChangeListener } from '../notifier.js'
import { ConfigNotifier } from '../notifier.js'
import { featureLookup } from '../slice.js'
import type { ConfigProvider, ConfigSnapshot } from '../types.js'

export class ConfigShard<T> implements SelfRefreshable {
  #validated: T
  #snapshot: ConfigSnapshot
  #failures: readonly ConfigSliceFailure[]
  #secrets: ReadonlySet<string>
  #revision = 0
  #stamps: ReadonlyMap<string, unknown>
  #sources: number
  #snapshotHandle: ConfigHandle<T> | undefined
  #snapshotStamp: number | undefined
  readonly #options: BootstrapOptions<T>
  readonly #notifier: ConfigNotifier<T>
  readonly handle: ConfigHandle<T>

  static async bootstrap<T>(options: BootstrapOptions<T>): Promise<ConfigShard<T>> {
    // Explicit type argument: the config type is already known here, so this must not go through the
    // schema-inferring overload, which cannot recover `T` from a TypeBox schema.
    const result = await bootstrapConfig<T>(options)

    // Start-up fails fast. Isolation is what a *refresh* needs — a running process must not lose working
    // features to a bad reload — but a process that cannot configure a feature at all should say so and stop,
    // rather than come up and fail later at whatever moment that feature is first used.
    if (result.failures.length > 0) {
      throw new ErrConfigSlices(result.failures)
    }

    return new ConfigShard(result, options)
  }

  private constructor(result: ConfigBootstrapResult<T>, options: BootstrapOptions<T>) {
    this.#validated = result.validated
    this.#snapshot = result.snapshot
    this.#failures = result.failures
    this.#secrets = result.secrets
    this.#options = options
    const sources = sourcesOf(options)
    this.#stamps = stampsOf(sources.resolved())
    this.#sources = sources.revision
    this.handle = createLiveAccessors(
      () => this.#validated,
      () => this.#revision,
      featureLookup(options.features, slice => slice.config),
    )
    this.#notifier = new ConfigNotifier<T>(
      () => 'the application configuration',
      () => options.warn,
    )
    // The first configuration is what "unchanged" is measured against, never a change in itself.
    this.#notifier.record(result.validated)
  }

  /** Notified when the configuration as a whole changes. See `ConfigSlice.onChange` for the delivery model. */
  onChange(listener: ConfigChangeListener<T>): () => void {
    return this.#notifier.add(listener)
  }

  /** Resolves once no change notification is in flight or pending, at the root or in any slice. */
  async settled(): Promise<void> {
    await Promise.all([this.#notifier.settled(), ...(this.#options.slices ?? []).map(spec => spec.slice.settled())])
  }

  /** The validated tree as of now — deep-frozen, and replaced wholesale rather than mutated by a refresh. */
  get validated(): T {
    return this.#validated
  }

  /**
   * A handle over the tree as it stands, fixed: unlike {@link handle}, a later refresh is not observed through
   * it. What a request-scoped read is served from, so a refresh landing mid-request cannot change the answers a
   * request already started with.
   *
   * Built once per revision and shared by every reader, rather than per read — the tree it closes over is
   * replaced wholesale, so one handle per revision is exactly as fixed as one per reader.
   */
  get snapshotHandle(): ConfigHandle<T> {
    if (this.#snapshotStamp !== this.#revision || this.#snapshotHandle === undefined) {
      const validated = this.#validated

      this.#snapshotHandle = createLiveAccessors(
        () => validated,
        undefined,
        featureLookup(this.#options.features, slice => slice.snapshot()),
      )
      this.#snapshotStamp = this.#revision
    }

    return this.#snapshotHandle
  }

  /** Advances only when a refresh actually re-resolved. A skipped refresh leaves it alone. */
  get revision(): number {
    return this.#revision
  }

  get diagnostics(): ConfigDiagnostics {
    return createConfigDiagnostics(this.#validated, this.#snapshot, this.#failures, this.#secrets)
  }

  /**
   * Re-resolves, unless nothing could possibly have changed.
   *
   * Most sources cannot reload: the environment a process started with, the arguments it was given, an inline
   * object. An application whose sources are all of that kind refreshes for free — no provider is asked to
   * load, nothing is re-validated, and no object is replaced, so every reference anything is holding stays
   * exactly as valid as it was.
   *
   * Failures here are **not** thrown. Each affected slice keeps serving its last good values and records the
   * error; the rest of the application refreshes normally. A caller who wants to know reads
   * {@link diagnostics}, and the warning hook reports it without anyone having to ask.
   */
  async [kSelfRefresh](): Promise<void> {
    const sources = sourcesOf(this.#options)
    const providers = sources.resolved()

    if (!this.#mayHaveChanged(sources.revision, providers)) {
      return
    }

    const result = await bootstrapConfig<T>(this.#options)

    this.#validated = result.validated
    this.#snapshot = result.snapshot
    this.#failures = result.failures
    // A slice registered since the last resolve may have brought new secrets with it.
    this.#secrets = result.secrets
    this.#stamps = stampsOf(providers)
    this.#sources = sources.revision
    this.#revision++
    this.#notifier.record(result.validated)

    // Every slice has published by now, so a listener sees a world that is updated all the way through rather
    // than one caught mid-refresh. Nothing here is awaited: what a feature does about new configuration is its
    // own business and must not hold up the refresh.
    this.#notifier.flush()
    notifySlices(this.#options.slices)

    for (const failure of result.failures) {
      this.#options.warn?.(
        `Config refresh failed for "${failure.path}"; it keeps the values from the previous resolve: ` +
          messageOf(failure.error),
      )
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      sourcesOf(this.#options)
        .resolved()
        .map(p => Promise.resolve(p.dispose?.())),
    )
  }

  /**
   * Two tiers, cheapest first.
   *
   * The stamp tier is not an optimization on top of the flag — it is what makes the flag useful at all. Every
   * application registers a mutable source per configuration band, so "is any source reloadable" is always
   * true; "did any reloadable source actually change" is the question worth asking.
   */
  #mayHaveChanged(sources: number, providers: readonly ConfigProvider[]): boolean {
    // A source registered (or removed) since the last resolve is a change in its own right, whatever the
    // sources themselves are capable of.
    if (sources !== this.#sources) {
      return true
    }

    const reloadable = providers.filter(p => p.reloadable === true)

    if (reloadable.length === 0) {
      return false
    }

    return reloadable.some(provider => {
      if (provider.revision === undefined) {
        // Cannot say without doing the work — a config server has to be asked.
        return true
      }
      return provider.revision() !== this.#stamps.get(provider.id)
    })
  }
}

function stampsOf(providers: readonly ConfigProvider[]): ReadonlyMap<string, unknown> {
  const stamps = new Map<string, unknown>()

  for (const provider of providers) {
    if (provider.reloadable === true && provider.revision !== undefined) {
      stamps.set(provider.id, provider.revision())
    }
  }

  return stamps
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
