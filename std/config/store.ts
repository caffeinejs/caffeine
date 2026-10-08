import { toMillis } from '../duration/index.js'
import { errMessage } from '../framework/err/index.js'
import type { Logger } from '../logger/logger.js'
import { ErrConfig, ErrConfigValidation, messageOf } from './errors.js'
import { describeSource, explainPath } from './explain.js'
import { mergeInterpolated } from './interpolation.js'
import { ConfigEvents, kFirstLoadMs, loadChannel, publishChange, reloadChannel, traced } from './observe.js'
import { deepEquals, reconcile } from './reconcile.js'
import { validateConfig } from './schema.js'
import { countLeaves, freezeCopy, freezeDeep, isForbiddenKey, isPlainObject, toParts } from './tree.js'
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
} from './types.js'

/** Runs the first load. {@link loadConfig} calls it; nothing else should. */
export const kFirstLoad: unique symbol = Symbol('@caffeinejs/config:first-load')

/**
 * The first load's merged tree, interpolated, before validation. The application reads its own `caffeine` block
 * from it, once, at start-up.
 */
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
  /** The source's own `load()` is running, possibly one the store stopped waiting for when it timed out. */
  loading: boolean
}

interface PendingReload {
  readonly states: Set<SourceState>
  readonly trigger: ReloadTrigger
  readonly promise: Promise<ConfigReloadOutcome>
  readonly resolve: (outcome: ConfigReloadOutcome) => void
}

/** One `onChange` listener, and what it has been handed. */
interface Subscription<T> {
  // A method rather than a function-typed property, so `T` stays covariant as `ConfigStore<out T>` declares.
  listener(...args: Parameters<ConfigChangeListener<ConfigSnapshot<T>>>): unknown
  /** The snapshot it was last called with: the `previous` of its next call. */
  seen: ConfigSnapshot<T>
  /** The promise its last call returned has not settled yet. */
  busy: boolean
  /** The newest swap that landed while it was busy, with every path changed since it was last called. */
  queued: { readonly next: ConfigSnapshot<T>; readonly change: ConfigChange } | undefined
}

/**
 * The runtime of an application's configuration: it loads the sources, validates the result, swaps in a new frozen
 * snapshot when a live source changes it, and says why every value is what it is.
 *
 * Instances come from {@link loadConfig}.
 */
export class ConfigStore<out T> {
  /** What `loadConfig()` was given. `ConfigModule` reads the keys off it. */
  readonly definition: ConfigDefinition<T>
  readonly #profiles: readonly string[]
  readonly #logger: () => Logger
  readonly #events: ConfigEvents
  readonly #states: readonly SourceState[]
  readonly #closing = new AbortController()
  readonly #scheduler: TriggerScheduler
  readonly #listeners = new Set<Subscription<T>>()
  #current!: ConfigSnapshot<T>
  #merged!: ConfigObject
  #revision = 0
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
    this.#scheduler = new TriggerScheduler(
      (state, trigger) => this.#request([state], trigger),
      (state, error) => this.#reportFailure(state, error),
    )
  }

  /**
   * The snapshot of the current revision. Frozen: a reload that changes something replaces it and never mutates it,
   * and one that changes nothing keeps it, identity included. A new snapshot shares with the one before it every
   * subtree the reload did not change, so comparing a block's identity tells whether it changed.
   */
  get current(): ConfigSnapshot<T> {
    return this.#current
  }

  /** The active profiles every source loads with: the ones named in code, then the host's. */
  get profiles(): readonly string[] {
    return this.#profiles
  }

  /** 0 after the first load, plus one per swap. A reload that changed nothing leaves it alone. */
  get revision(): number {
    return this.#revision
  }

  get [kMergedTree](): ConfigObject {
    return freezeDeep(this.#merged)
  }

  get [kFirstLoadMs](): number {
    return this.#firstLoadMs
  }

  /**
   * Loads every source, merges, validates and freezes. A source that fails fails the load, unless it is optional.
   *
   * @throws ErrConfig `ERR_CONFIG_SOURCE`, `ERR_CONFIG_SOURCE_TIMEOUT`, or the source's own `ErrConfig`.
   * @throws ErrConfigValidation when a placeholder cannot be interpolated, or the merged tree does not satisfy the
   *   schema.
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

    const merged = mergeInterpolated(this.#layers())
    const validated = validateRoot(this.definition, merged)

    this.#merged = merged
    // Validation deletes the keys a schema does not declare, and V8 keeps an object it deleted from in dictionary
    // mode. A fresh copy of each new node is back in fast mode, where a read is a field load.
    this.#current = freezeCopy(validated) as ConfigSnapshot<T>
    this.#firstLoadMs = performance.now() - started
  }

  /**
   * Called after every reload that swapped in a new snapshot, synchronously, before the reload resolves. Never for
   * a reload that changed nothing or was rejected. Returns the call that unsubscribes.
   *
   * A reload does not wait for a promise the listener returns, and the listener never runs concurrently with itself:
   * a swap that lands before that promise settles reaches it once it has, and of several such swaps only the newest,
   * with `previous` the snapshot it was last called with and every path changed since. A throw or a rejection is
   * logged, and the other listeners still run.
   */
  onChange(listener: ConfigChangeListener<ConfigSnapshot<T>>): () => void {
    const subscription: Subscription<T> = { listener, seen: this.#current, busy: false, queued: undefined }
    this.#listeners.add(subscription)
    return () => {
      this.#listeners.delete(subscription)
    }
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

  /**
   * Why a path has the value it has. A string path splits on `.` and on `[n]`. A key that holds a literal dot needs
   * the array form.
   *
   * Every value comes back as it is, a secret included: treat the result as sensitive.
   */
  explain(path: string | readonly string[]): ConfigExplanation {
    return explainPath(toParts(path), this.#current, this.#layers())
  }

  /** The state of the store. The snapshot holds every value as it is, a secret included: treat it as sensitive. */
  inspect(): ConfigInspection {
    return {
      revision: this.#revision,
      profiles: this.#profiles,
      sources: this.#states.map(describeSource),
      snapshot: this.#current,
    }
  }

  /** Resolves once no reload is running or queued. For tests. */
  async settled(): Promise<void> {
    // A run that ends starts the one queued behind it, if any: settle again once this one has.
    while (this.#running !== undefined) {
      await this.#running
    }
  }

  /**
   * Aborts loads in flight, disarms every trigger, drops every change listener and closes every source. The last
   * snapshot stays readable, because shutdown code reads configuration.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true

    this.#closing.abort()
    this.#scheduler.stop()

    this.#listeners.clear()

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
        failures.push({ source: state.source.name, optional: state.source.optional === true, error: result.reason })
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

    let validated: Record<string, unknown>
    try {
      validated = validateRoot(
        this.definition,
        mergeInterpolated(this.#states.flatMap(state => candidates.get(state) ?? state.layers)),
      )
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
      })
      return this.#outcome('rejected', [], failures, error)
    }

    for (const [state, layers] of candidates) {
      commit(state, layers)
    }
    // A verdict is about a merge, not about one source: once the rest of the tree changed, a candidate rejected
    // before may be valid, so none of them may be short-circuited again.
    for (const state of this.#states) {
      state.rejected = undefined
    }

    const changed: string[] = []
    const next = reconcile(this.#current, validated, changed)
    if (changed.length === 0) {
      // Only keys the schema drops differed.
      this.#events.unchanged({ trigger, sources, ms: performance.now() - started })
      return this.#outcome('unchanged', [], failures)
    }

    // The swap: one synchronous block, so a reader sees the old revision or the new one, never a mix.
    this.#current = next
    this.#revision++

    const change: ConfigChange = { revision: this.#revision, changed }
    this.#events.reloaded({ revision: this.#revision, trigger, sources, changed, ms: performance.now() - started })
    publishChange(() => ({ store: this as ConfigStore<unknown>, revision: change.revision, changed }))
    this.#notify(next, change)

    return this.#outcome('applied', changed, failures)
  }

  #notify(next: ConfigSnapshot<T>, change: ConfigChange): void {
    for (const subscription of [...this.#listeners]) {
      // A listener unsubscribed by an earlier one, or by `close()`, hears nothing more.
      if (!this.#listeners.has(subscription)) {
        continue
      }

      if (!subscription.busy) {
        this.#deliver(subscription, next, change)
        continue
      }

      const queued = subscription.queued
      subscription.queued = {
        next,
        change:
          queued === undefined
            ? change
            : { revision: change.revision, changed: [...new Set([...queued.change.changed, ...change.changed])] },
      }
    }
  }

  #deliver(subscription: Subscription<T>, next: ConfigSnapshot<T>, change: ConfigChange): void {
    const previous = subscription.seen
    subscription.seen = next

    let result: unknown
    try {
      result = subscription.listener(next, previous, change)
    } catch (error) {
      this.#events.listenerFailed(error)
      return
    }

    if (!isThenable(result)) {
      return
    }

    // Until the promise settles, a swap waits in `queued`, so a slow call can never finish after a newer one.
    subscription.busy = true
    const settle = (): void => {
      subscription.busy = false
      const queued = subscription.queued
      subscription.queued = undefined
      if (queued !== undefined && this.#listeners.has(subscription)) {
        this.#deliver(subscription, queued.next, queued.change)
      }
    }
    Promise.resolve(result).then(settle, (error: unknown) => {
      this.#events.listenerFailed(error)
      settle()
    })
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

    // A source that ignored the signal of a load that timed out may still be running it, and never runs two.
    if (state.loading) {
      throw new ErrConfig(
        errMessage(`Cannot load config source "${name}": the load that timed out is still running`)
          .reference('@caffeinejs/std', ErrConfig)
          .build(),
        'ERR_CONFIG_SOURCE_TIMEOUT',
      )
    }

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
            errMessage(`Cannot load config source "${name}": no answer within ${timeoutMs} ms`)
              .reference('@caffeinejs/std', ErrConfig)
              .build(),
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
      state.loading = true
      const loading = new Promise<readonly ConfigLayer[]>(resolve => resolve(state.source.load(context)))
      // Cleared when the source's own call settles, which can be long after the race below stopped waiting for it.
      const settled = (): void => {
        state.loading = false
      }
      void loading.then(settled, settled)

      const layers = await Promise.race([loading, aborted])
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

      return Object.freeze({
        name: layer.name,
        data,
        origins: layer.origins,
        profile: layer.profile,
        interpolate: layer.interpolate,
      })
    })
  }
}

function stateOf(sources: readonly ConfigSource[]): SourceState[] {
  const names = new Set<string>()

  return sources.map(source => {
    if (names.has(source.name)) {
      throw new ErrConfig(
        errMessage(`Cannot register config source "${source.name}": the name is already taken`)
          .solutions('Give one of the sources a name of its own')
          .reference('@caffeinejs/std', ErrConfig)
          .build(),
        'ERR_CONFIG_DUPLICATE_SOURCE',
      )
    }
    names.add(source.name)

    const pollMs = source.pollInterval === undefined ? undefined : toMillis(source.pollInterval)
    if (pollMs !== undefined && !(pollMs > 0)) {
      throw new ErrConfig(
        errMessage(`Cannot register config source "${source.name}": the poll interval must be positive`)
          .reference('@caffeinejs/std', ErrConfig)
          .build(),
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
      loading: false,
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
  state.keys = layers.reduce((sum, layer) => sum + countLeaves(layer.data), 0)
}

function validateRoot<T>(definition: ConfigDefinition<T>, merged: ConfigObject): Record<string, unknown> {
  const validated = validateConfig(definition.schema, merged)

  if (!isPlainObject(validated)) {
    throw new ErrConfigValidation([{ path: '', message: 'the configuration root must be an object' }])
  }

  return validated
}

/**
 * Whether two sets of layers carry the same data. Provenance alone does not make a reload; whether a layer
 * interpolates changes what it means, so that does.
 */
function sameLayers(a: readonly ConfigLayer[], b: readonly ConfigLayer[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (layer, i) =>
        layer.name === b[i].name &&
        (layer.interpolate === true) === (b[i].interpolate === true) &&
        deepEquals(layer.data, b[i].data),
    )
  )
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function isLayer(value: unknown): value is ConfigLayer {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ConfigLayer).name === 'string' &&
    isPlainObject((value as ConfigLayer).data)
  )
}

// Not `freezeCopy`: this copy reports each forbidden key it drops, and leaves out a key whose value is `undefined`.
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
  return new ErrConfig(
    errMessage(`Cannot load config source "${name}": ${reason}`).reference('@caffeinejs/std', ErrConfig).build(),
    'ERR_CONFIG_SOURCE',
    cause,
  )
}
