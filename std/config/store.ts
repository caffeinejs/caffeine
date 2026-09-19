import type { Logger } from '../logger/logger.js'
import { toMillis } from '../shutdown/shutdown_options.js'
import { ChangeNotifier } from './change_notifier.js'
import { ErrConfig, ErrConfigValidation, messageOf } from './errors.js'
import { describeSource, explainPath } from './explain.js'
import { createLive, syncLive } from './live.js'
import { mergeLayers } from './merge.js'
import { ConfigEvents, kFirstLoadMs, loadChannel, publishChange, reloadChannel, traced } from './observe.js'
import { reconcile } from './reconcile.js'
import { collectSecretPaths, redactValue, type SecretPaths } from './redact.js'
import { validateConfig } from './schema.js'
import { countLeaves, freezeDeep, isForbiddenKey, isPlainObject, toParts } from './tree.js'
import { TriggerScheduler, pollBackoff } from './triggers.js'
import type {
  ConfigChange,
  ConfigChangeListener,
  ConfigDefinition,
  ConfigExplanation,
  ConfigInspection,
  ConfigLayer,
  ConfigLoadContext,
  ConfigObject,
  ConfigReloadOutcome,
  ConfigSnapshot,
  ConfigSource,
  ConfigSourceFailure,
  ConfigTrigger,
  ConfigView,
  LiveConfig,
} from './types.js'

/** Runs the first load. {@link loadConfig} calls it; nothing else should. */
export const kFirstLoad: unique symbol = Symbol('@caffeinejs/config:first-load')

/** The merged tree before validation. The application reads its own `caffeine` block from it. */
export const kMergedTree: unique symbol = Symbol('@caffeinejs/config:merged-tree')

type ReloadTrigger = Exclude<ConfigTrigger, 'static'>

export interface SourceState {
  readonly source: ConfigSource
  readonly trigger: ConfigTrigger
  readonly pollMs: number | undefined
  /** The last good layers, frozen. */
  layers: readonly ConfigLayer[]
  /** The last candidate that failed validation, so an identical one is not reported twice. */
  rejected: { readonly layers: readonly ConfigLayer[]; readonly error: ErrConfigValidation } | undefined
  keys: number
  lastLoadedAt: number
  lastLoadMs: number
  consecutiveFailures: number
  lastError: unknown
}

interface ViewState<T> {
  readonly select: (config: ConfigSnapshot<T>) => unknown
  readonly derive: ((selected: unknown) => unknown) | undefined
  readonly notifier: ChangeNotifier<unknown>
  /** A plain object whose `value` the store assigns, so a read is a property load. */
  readonly view: { -readonly [K in keyof ConfigView<unknown>]: ConfigView<unknown>[K] }
  selected: unknown
}

interface PendingReload {
  readonly states: Set<SourceState>
  readonly trigger: ReloadTrigger
  readonly promise: Promise<ConfigReloadOutcome>
  readonly resolve: (outcome: ConfigReloadOutcome) => void
}

/**
 * The runtime of an application's configuration: it loads the sources, validates the result, keeps it current as
 * live sources change, and says why every value is what it is.
 *
 * Instances come from {@link loadConfig}. The class is public so that it can be a container key.
 */
export class ConfigStore<T> {
  /** What `loadConfig()` was given. `ConfigModule` reads the keys off it. */
  readonly definition: ConfigDefinition<T>
  readonly #profiles: readonly string[]
  readonly #logger: () => Logger
  readonly #events: ConfigEvents
  readonly #states: readonly SourceState[]
  readonly #closing = new AbortController()
  readonly #views = new Set<ViewState<T>>()
  readonly #scheduler: TriggerScheduler<SourceState>
  #notifier!: ChangeNotifier<ConfigSnapshot<T>>
  #current!: ConfigSnapshot<T>
  #live!: LiveConfig<T>
  #merged!: ConfigObject
  #secrets: SecretPaths = []
  #revision = 0
  #swappedAt = 0
  #firstLoadMs = 0
  #running: Promise<ConfigReloadOutcome> | undefined
  #pending: PendingReload | undefined
  #started = false
  #closed = false

  /**
   * @throws ErrConfig `ERR_CONFIG_DUPLICATE_SOURCE` when two sources share a name.
   * @throws ErrConfig `ERR_CONFIG_SOURCE` when a poll interval is not positive.
   */
  constructor(definition: ConfigDefinition<T>, options: { profiles: readonly string[]; logger: () => Logger }) {
    this.definition = definition
    this.#profiles = options.profiles
    this.#logger = options.logger
    this.#events = new ConfigEvents(options.logger)
    this.#states = stateOf(definition.sources)
    this.#scheduler = new TriggerScheduler<SourceState>(
      (state, trigger) => this.#request([state], trigger),
      (state, error) => this.#reportFailure(state, error),
    )
  }

  /** The object bound under the application key: one identity, and every field follows every reload. */
  get live(): LiveConfig<T> {
    return this.#live
  }

  /** The newest snapshot. Frozen: a reload replaces it and never mutates it. */
  get current(): ConfigSnapshot<T> {
    return this.#current
  }

  /** 0 after the first load, plus one per swap. A reload that changed nothing leaves it alone. */
  get revision(): number {
    return this.#revision
  }

  get [kMergedTree](): ConfigObject {
    return this.#merged
  }

  get [kFirstLoadMs](): number {
    return this.#firstLoadMs
  }

  /**
   * Loads every source, merges, validates and freezes. A source that fails fails the load, unless it is optional.
   *
   * @throws ErrConfig `ERR_CONFIG_SOURCE`, `ERR_CONFIG_SOURCE_TIMEOUT`, or the source's own `ErrConfig`.
   * @throws ErrConfigValidation when the merged tree does not satisfy the schema.
   */
  async [kFirstLoad](): Promise<void> {
    const started = performance.now()
    const results = await Promise.allSettled(this.#states.map(state => this.#load(state, 'start')))

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const state = this.#states[i]

      if (result.status === 'fulfilled') {
        commit(state, result.value)
      } else if (state.source.optional === true) {
        state.consecutiveFailures = 1
        state.lastError = result.reason
      } else {
        throw result.reason
      }
    }

    const merged = mergeLayers(this.#layers())
    const validated = validateRoot(this.definition, merged)

    this.#merged = freezeDeep(merged)
    this.#current = freezeDeep(validated) as ConfigSnapshot<T>
    this.#live = createLive(this.#current)
    this.#secrets = collectSecretPaths(this.definition.schema)
    this.#notifier = new ChangeNotifier<ConfigSnapshot<T>>(this.#current, error => this.#events.listenerFailed(error))
    this.#swappedAt = Date.now()
    this.#firstLoadMs = performance.now() - started
  }

  /**
   * A value derived from the configuration that the store keeps current.
   *
   * `select` runs now and once per swap, never on a read. A selection deep-equal to the previous one keeps its
   * identity, and then nothing else happens. `derive` runs only when the selection changed, and its result is
   * compared by identity alone, so anything that is not plain data belongs there.
   *
   * The store holds the view until it is closed: create views while wiring, never per request.
   */
  view<S>(select: (config: ConfigSnapshot<T>) => S): ConfigView<S>
  view<S, V>(select: (config: ConfigSnapshot<T>) => S, derive: (selected: S) => V): ConfigView<V>
  view(select: (config: ConfigSnapshot<T>) => unknown, derive?: (selected: unknown) => unknown): ConfigView<unknown> {
    const selected = freezeSelection(select(this.#current))
    const value = derive === undefined ? selected : derive(selected)
    const notifier = new ChangeNotifier<unknown>(value, error => this.#events.listenerFailed(error))

    const state: ViewState<T> = {
      select,
      derive,
      notifier,
      selected,
      view: {
        value,
        onChange: listener => notifier.add(listener),
        close: () => {
          this.#views.delete(state)
          notifier.clear()
        },
      },
    }

    if (!this.#closed) {
      this.#views.add(state)
    }

    return state.view
  }

  /** Notified after every swap. Returns the call that unsubscribes. */
  onChange(listener: ConfigChangeListener<ConfigSnapshot<T>>): () => void {
    return this.#notifier.add(listener)
  }

  /**
   * Reloads every live source now. A static source is never loaded again. Never rejects: the outcome says what
   * happened, and a rejected reload changed nothing at all.
   */
  reload(): Promise<ConfigReloadOutcome> {
    return this.#request(
      this.#states.filter(state => state.trigger !== 'static'),
      'manual',
    )
  }

  /** Arms the poll timers and the watchers. Idempotent. `loadConfig()` calls it unless told not to. */
  start(): void {
    if (this.#started || this.#closed) {
      return
    }
    this.#started = true

    for (const state of this.#states) {
      if (state.pollMs !== undefined) {
        this.#events.sourcePolling(state.source.name, state.pollMs)
      }
      if (state.source.watch !== undefined) {
        this.#events.sourceWatching(state.source.name)
      }
    }

    this.#scheduler.start(this.#states)
  }

  /** A string path splits on `.`. A key that holds a literal dot needs the array form. */
  explain(path: string | readonly string[]): ConfigExplanation {
    return explainPath(toParts(path), this.#current, this.#layers(), this.#secrets)
  }

  inspect(): ConfigInspection {
    return {
      revision: this.#revision,
      swappedAt: this.#swappedAt,
      profiles: this.#profiles,
      sources: this.#states.map(describeSource),
      snapshot: redactValue(this.#current, [], this.#secrets),
    }
  }

  /** Resolves once no reload is running or queued and no change delivery is running or pending. For tests. */
  async settled(): Promise<void> {
    while (this.#running !== undefined) {
      await this.#running
    }

    await Promise.all([this.#notifier.settled(), ...[...this.#views].map(state => state.notifier.settled())])
  }

  /**
   * Aborts loads in flight, disarms every trigger, closes every view and closes every source. The last snapshot
   * and the live config object stay readable, because shutdown code reads configuration.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true

    this.#closing.abort()
    this.#scheduler.stop()

    for (const state of [...this.#views]) {
      state.view.close()
    }
    this.#notifier?.clear()

    await Promise.all(
      this.#states.map(async state => {
        try {
          await state.source.close?.()
        } catch (error) {
          this.#reportFailure(state, error)
        }
      }),
    )

    this.#events.closed()
  }

  #reportFailure(state: SourceState, error: unknown): void {
    this.#events.sourceFailed({ source: state.source.name, err: error, consecutiveFailures: state.consecutiveFailures })
  }

  #layers(): ConfigLayer[] {
    return this.#states.flatMap(state => state.layers)
  }

  /** Single-flight: a request arriving mid-run joins the one follow-up run, and awaits it. */
  #request(states: readonly SourceState[], trigger: ReloadTrigger): Promise<ConfigReloadOutcome> {
    if (this.#closed || states.length === 0) {
      return Promise.resolve(this.#outcome('unchanged', [], []))
    }

    if (this.#running === undefined) {
      const running = this.#run(states, trigger).finally(() => {
        this.#running = undefined
        this.#startPending()
      })
      this.#running = running
      return running
    }

    let pending = this.#pending
    if (pending === undefined) {
      let resolve!: (outcome: ConfigReloadOutcome) => void
      const promise = new Promise<ConfigReloadOutcome>(r => {
        resolve = r
      })
      pending = { states: new Set(), trigger, promise, resolve }
      this.#pending = pending
    }

    for (const state of states) {
      pending.states.add(state)
    }

    return pending.promise
  }

  #startPending(): void {
    const pending = this.#pending
    if (pending === undefined) {
      return
    }

    this.#pending = undefined
    void this.#request([...pending.states], pending.trigger).then(pending.resolve)
  }

  #run(states: readonly SourceState[], trigger: ReloadTrigger): Promise<ConfigReloadOutcome> {
    return traced(
      reloadChannel,
      () => ({ store: this as ConfigStore<unknown>, trigger, sources: states.map(state => state.source.name) }),
      () => this.#reloadOnce(states, trigger),
    )
  }

  async #reloadOnce(states: readonly SourceState[], trigger: ReloadTrigger): Promise<ConfigReloadOutcome> {
    const started = performance.now()
    const failures: ConfigSourceFailure[] = []
    const candidates = new Map<SourceState, readonly ConfigLayer[]>()
    const loaded = states.map(state => state.source.name)

    const results = await Promise.allSettled(states.map(state => this.#load(state, trigger)))

    if (this.#closed) {
      return this.#outcome('unchanged', [], failures)
    }

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const state = states[i]

      if (result.status === 'rejected') {
        state.consecutiveFailures++
        state.lastError = result.reason
        failures.push({ source: state.source.name, error: result.reason })
        this.#events.sourceFailed({
          source: state.source.name,
          err: result.reason,
          consecutiveFailures: state.consecutiveFailures,
          ...(state.pollMs === undefined
            ? {}
            : { nextAttemptMs: pollBackoff(state.pollMs, state.consecutiveFailures) }),
        })
        continue
      }

      if (state.consecutiveFailures > 0) {
        this.#events.sourceRecovered(state.source.name, state.consecutiveFailures)
      }
      state.consecutiveFailures = 0
      state.lastError = undefined

      if (!sameLayers(state.layers, result.value)) {
        candidates.set(state, result.value)
      }
    }

    if (candidates.size === 0) {
      this.#events.unchanged({ trigger, sources: loaded, ms: performance.now() - started })
      return this.#outcome('unchanged', [], failures)
    }

    const sources = [...candidates.keys()].map(state => state.source.name)
    const repeated = [...candidates].every(
      ([state, layers]) => state.rejected !== undefined && sameLayers(state.rejected.layers, layers),
    )
    if (repeated) {
      // Already reported when it was first rejected. A poll that finds it again says nothing new.
      this.#events.unchanged({ trigger, sources, ms: performance.now() - started })
      return this.#outcome('rejected', [], failures, [...candidates.keys()][0].rejected!.error)
    }

    const merged = mergeLayers(this.#states.flatMap(state => candidates.get(state) ?? state.layers))

    let validated: Record<string, unknown>
    try {
      validated = validateRoot(this.definition, merged)
    } catch (thrown) {
      const error =
        thrown instanceof ErrConfigValidation
          ? thrown
          : new ErrConfigValidation([{ path: '', message: messageOf(thrown) }], thrown)

      for (const [state, layers] of candidates) {
        state.rejected = { layers, error }
      }
      this.#events.rejected({
        trigger,
        sources,
        issues: error.issues,
        revision: this.#revision,
        secrets: this.#secrets,
      })
      return this.#outcome('rejected', [], failures, error)
    }

    const changed: string[] = []
    const next = reconcile(this.#current, validated, changed) as ConfigSnapshot<T>

    for (const [state, layers] of candidates) {
      commit(state, layers)
    }
    this.#merged = freezeDeep(merged)

    if (next === this.#current) {
      // Only keys the schema drops differed.
      this.#events.unchanged({ trigger, sources, ms: performance.now() - started })
      return this.#outcome('unchanged', [], failures)
    }

    // The swap: one synchronous block, so a reader sees the old revision or the new one, never a mix.
    this.#current = freezeDeep(next)
    this.#revision++
    this.#swappedAt = Date.now()
    syncLive(this.#live, next)
    const changedViews = this.#recomputeViews(next)

    const change: ConfigChange = { revision: this.#revision, changed }
    this.#events.reloaded({ revision: this.#revision, trigger, sources, changed, ms: performance.now() - started })
    publishChange(() => ({ store: this as ConfigStore<unknown>, revision: change.revision, changed }))

    // Listeners run after everything is at the new revision, and a reload never waits for them.
    this.#notifier.record(next, change)
    for (const state of changedViews) {
      state.notifier.record(state.view.value, change)
    }
    this.#notifier.flush()
    for (const state of changedViews) {
      state.notifier.flush()
    }

    return this.#outcome('applied', changed, failures)
  }

  #recomputeViews(next: ConfigSnapshot<T>): ViewState<T>[] {
    const changed: ViewState<T>[] = []

    for (const state of this.#views) {
      try {
        const selected = reconcile(state.selected, state.select(next))
        if (selected === state.selected) {
          continue
        }

        freezeSelection(selected)
        const value = state.derive === undefined ? selected : state.derive(selected)
        state.selected = selected
        state.view.value = value
        changed.push(state)
      } catch (error) {
        this.#events.viewFailed(error)
      }
    }

    return changed
  }

  #outcome(
    status: ConfigReloadOutcome['status'],
    changed: readonly string[],
    failures: readonly ConfigSourceFailure[],
    error?: ErrConfigValidation,
  ): ConfigReloadOutcome {
    return { status, revision: this.#revision, changed, failures, ...(error === undefined ? {} : { error }) }
  }

  #load(state: SourceState, trigger: ConfigTrigger | 'start'): Promise<readonly ConfigLayer[]> {
    return traced(
      loadChannel,
      () => ({ store: this as ConfigStore<unknown>, source: state.source.name, trigger }),
      () => this.#loadOnce(state),
    )
  }

  /** Loads one source, bounded by the load timeout and by `close()`, and accepts what it returned. */
  async #loadOnce(state: SourceState): Promise<readonly ConfigLayer[]> {
    const name = state.source.name
    const controller = new AbortController()
    const timeoutMs = this.definition.loadTimeoutMs

    const onClose = (): void => controller.abort(errSource(name, 'the configuration was closed'))
    if (this.#closing.signal.aborted) {
      onClose()
    } else {
      this.#closing.signal.addEventListener('abort', onClose, { once: true })
    }

    const timer = setTimeout(
      () =>
        controller.abort(
          new ErrConfig(
            `Cannot load config source "${name}": no answer within ${timeoutMs} ms`,
            'ERR_CONFIG_SOURCE_TIMEOUT',
          ),
        ),
      timeoutMs,
    )
    timer.unref?.()

    // A source that ignores the signal still cannot hang the load: the race settles when the signal aborts.
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(controller.signal.reason)
      if (controller.signal.aborted) {
        fail()
      } else {
        controller.signal.addEventListener('abort', fail, { once: true })
      }
    })

    const context: ConfigLoadContext = {
      profiles: this.#profiles,
      signal: controller.signal,
      logger: this.#logger().child({ name: 'config', source: name }),
    }

    const started = performance.now()

    try {
      const layers = await Promise.race([
        new Promise<readonly ConfigLayer[]>(resolve => resolve(state.source.load(context))),
        aborted,
      ])
      const accepted = this.#accept(state, layers)
      state.lastLoadedAt = Date.now()
      state.lastLoadMs = performance.now() - started
      return accepted
    } catch (error) {
      throw error instanceof ErrConfig ? error : errSource(name, messageOf(error), error)
    } finally {
      clearTimeout(timer)
      this.#closing.signal.removeEventListener('abort', onClose)
    }
  }

  /**
   * Checks the shape of what a source returned and takes a frozen copy of it, without `__proto__`, `constructor` or
   * `prototype` keys. A copy, so that neither the source nor the store can change the other's data.
   */
  #accept(state: SourceState, layers: unknown): readonly ConfigLayer[] {
    const name = state.source.name

    if (!Array.isArray(layers)) {
      throw errSource(name, 'load() must return an array of layers')
    }

    return layers.map((layer: unknown) => {
      if (!isLayer(layer)) {
        throw errSource(name, 'every layer needs a string name and an object as data')
      }

      const dropped: string[] = []
      const data = copyTree(layer.data, '', dropped) as ConfigObject
      for (const path of dropped) {
        this.#events.keyIgnored(name, layer.name, path)
      }

      return Object.freeze({ name: layer.name, data, origins: layer.origins, profile: layer.profile })
    })
  }
}

function stateOf(sources: readonly ConfigSource[]): SourceState[] {
  const names = new Set<string>()

  return sources.map(source => {
    if (names.has(source.name)) {
      throw new ErrConfig(
        `Cannot register config source "${source.name}": the name is already taken`,
        'ERR_CONFIG_DUPLICATE_SOURCE',
        undefined,
        'Give one of the sources a name of its own',
      )
    }
    names.add(source.name)

    const pollMs = source.pollInterval === undefined ? undefined : toMillis(source.pollInterval)
    if (pollMs !== undefined && !(pollMs > 0)) {
      throw new ErrConfig(
        `Cannot register config source "${source.name}": the poll interval must be positive`,
        'ERR_CONFIG_SOURCE',
      )
    }

    return {
      source,
      trigger: triggerOf(source),
      pollMs,
      layers: [],
      rejected: undefined,
      keys: 0,
      lastLoadedAt: 0,
      lastLoadMs: 0,
      consecutiveFailures: 0,
      lastError: undefined,
    }
  })
}

function triggerOf(source: ConfigSource): ConfigTrigger {
  if (source.watch !== undefined) {
    return 'watch'
  }
  if (source.pollInterval !== undefined) {
    return 'poll'
  }
  return source.live === true ? 'manual' : 'static'
}

function commit(state: SourceState, layers: readonly ConfigLayer[]): void {
  state.layers = layers
  state.rejected = undefined
  state.keys = layers.reduce((sum, layer) => sum + countLeaves(layer.data), 0)
}

function validateRoot<T>(definition: ConfigDefinition<T>, merged: ConfigObject): Record<string, unknown> {
  const validated = validateConfig(definition.schema, merged)

  if (!isPlainObject(validated)) {
    throw new ErrConfigValidation([{ path: '', message: 'the configuration root must be an object' }])
  }

  return validated
}

/** Whether two sets of layers carry the same data. Provenance alone does not make a reload. */
function sameLayers(a: readonly ConfigLayer[], b: readonly ConfigLayer[]): boolean {
  return (
    a.length === b.length &&
    a.every((layer, i) => layer.name === b[i].name && reconcile(layer.data, b[i].data) === layer.data)
  )
}

/** Selected plain data is frozen. Anything else is the caller's own object and is left alone. */
function freezeSelection<S>(selected: S): S {
  return isPlainObject(selected) || Array.isArray(selected) ? freezeDeep(selected) : selected
}

function isLayer(value: unknown): value is ConfigLayer {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ConfigLayer).name === 'string' &&
    isPlainObject((value as ConfigLayer).data)
  )
}

function copyTree(value: unknown, path: string, dropped: string[]): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((element, i) => copyTree(element, join(path, String(i)), dropped)))
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (isForbiddenKey(key)) {
        dropped.push(join(path, key))
      } else if (value[key] !== undefined) {
        out[key] = copyTree(value[key], join(path, key), dropped)
      }
    }
    return Object.freeze(out)
  }

  return value
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function errSource(name: string, reason: string, cause?: unknown): ErrConfig {
  return new ErrConfig(`Cannot load config source "${name}": ${reason}`, 'ERR_CONFIG_SOURCE', cause)
}
