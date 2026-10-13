import { Router, type HTTPPluginConfigurer } from '@caffeinejs/http'
import type { ConfigStore } from '@caffeinejs/std/config'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsConfigEntry, DevToolsConfigurationReport } from '../wire.js'

const kBuild = Symbol('caffeine.devtools.configuration.build')

// A path that looks like a secret keeps its value back even when values are shown. Tested against the whole dotted
// path, so a block named after one, `auth.secret.current`, is withheld whole.
const SENSITIVE = [/password|passwd|passphrase|secret|token|credential|private/i, /key$/i]

interface ConfigurationOptions {
  showValues: boolean
  masks: readonly RegExp[]
}

/** Fluently builds what the configuration slice sends. Values are withheld unless {@link showValues} is called. */
export class ConfigurationSliceBuilder {
  #showValues = false
  readonly #masks: RegExp[] = []

  /**
   * Sends each entry's value. One whose path looks like a secret, `db.password` or `signing.key`, or matches a
   * {@link mask} pattern stays withheld, and a URL's credentials are replaced.
   */
  showValues(show: boolean = true): this {
    this.#showValues = show
    return this
  }

  /** Withholds the values of the paths a pattern matches, tested against the dotted path, on top of the defaults. */
  mask(...patterns: RegExp[]): this {
    // A global or sticky pattern keeps state between `test()` calls, so one call in two would miss.
    this.#masks.push(...patterns.map(pattern => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))))
    return this
  }

  [kBuild](): ConfigurationOptions {
    return { showValues: this.#showValues, masks: [...SENSITIVE, ...this.#masks] }
  }
}

/**
 * Where the configuration came from, `GET <path>/configuration`: its revision and profiles, each source with when it
 * last loaded and its last failure's message, and every value's path with the layer and origin that set it.
 *
 * Values are withheld unless `showValues()` is called: the configuration holds the application's secrets as they are.
 *
 * ```ts
 * devTools(d => d.slices(configuration(c => c.showValues().mask(/^payments\./))))
 * ```
 */
export function configuration<C = unknown>(
  configure?: HTTPPluginConfigurer<ConfigurationSliceBuilder, C>,
): DevToolsSlice<C> {
  return {
    id: 'configuration',
    router: context => {
      const builder = new ConfigurationSliceBuilder()
      configure?.(builder, context)

      const options = builder[kBuild]()

      return new Router().get('/', () => report(context.store, options))
    },
  }
}

function report(store: ConfigStore<unknown>, options: ConfigurationOptions): DevToolsConfigurationReport {
  const inspection = store.inspect()
  const entries: DevToolsConfigEntry[] = []

  for (const [parts, value] of leaves(inspection.snapshot, [])) {
    const path = parts.join('.')
    const [winner] = store.explain(parts).layers
    const entry: DevToolsConfigEntry = { path }

    if (winner !== undefined) {
      entry.layer = winner.layer
      entry.origin = winner.origin
    }

    if (options.showValues) {
      if (options.masks.some(mask => mask.test(path))) {
        entry.masked = true
      } else {
        entry.value = withoutCredentials(value)
      }
    }

    entries.push(entry)
  }

  return {
    revision: inspection.revision,
    profiles: [...inspection.profiles],
    sources: inspection.sources.map(source => ({
      name: source.name,
      trigger: source.trigger,
      layers: [...source.layers],
      keys: source.keys,
      lastLoadedAt: source.lastLoadedAt,
      lastLoadMs: source.lastLoadMs,
      consecutiveFailures: source.consecutiveFailures,
      lastError: source.lastError === undefined ? undefined : messageOf(source.lastError),
    })),
    showsValues: options.showValues,
    entries,
  }
}

// Every value the tree holds, with its path. An array is one value: a source replaces it whole, so its layer is the
// array's.
function* leaves(node: unknown, parts: readonly string[]): Generator<[readonly string[], unknown]> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    yield [parts, node]
    return
  }

  const keys = Object.keys(node)

  if (keys.length === 0 && parts.length > 0) {
    yield [parts, node]
    return
  }

  for (const key of keys) {
    yield* leaves((node as Record<string, unknown>)[key], [...parts, key])
  }
}

function withoutCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCredentials)
  }

  if (typeof value !== 'string' || !URL.canParse(value)) {
    return value
  }

  const url = new URL(value)

  if (url.username === '' && url.password === '') {
    return value
  }

  url.username = '***'
  url.password = ''

  return url.href
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
