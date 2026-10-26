import type { ConfigStore } from '@caffeinejs/application/config'
import { DevTool, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import type { Duration } from '@caffeinejs/std/duration'

import { maskCredentials, REDACTED, Redactor, secretPaths } from './redact.js'

/** One configuration value, and where it came from. */
export interface PropertyRecord {
  /** The dotted path, `db.url`. */
  readonly path: string
  /** What set it: `env:DB_URL`, a file, a layer's name; `default` for a schema default. */
  readonly origin: string
  /** Masked when shown: a `$t.Secret` field, a path naming a secret, or one `redact(...)` names. */
  readonly secret: boolean
  /** Present only when the devtools were told to show values, with every secret masked. */
  readonly value?: unknown
}

/** One value and every layer that set it, winner first. */
export interface PropertyDetail extends PropertyRecord {
  readonly layers: ReadonlyArray<{ readonly layer: string; readonly origin: string; readonly value?: unknown }>
}

/** A configuration source, as the store last loaded it. */
export interface SourceRecord {
  readonly name: string
  readonly trigger: string
  readonly layers: readonly string[]
  readonly keys: number
  /** In milliseconds since the epoch; `0` before a load has succeeded. */
  readonly lastLoadedAt: number
  readonly lastLoadDuration: Duration
  readonly consecutiveFailures: number
  /** The message of the last failure, the password of any URL in it masked. */
  readonly lastError?: string
}

export interface ConfigToolOptions {
  /** Show values, secrets masked. Without it, a property names its path and origin only. */
  readonly showValues: boolean
  /** Paths to mask besides what the schema and the key names mark. */
  readonly redact: readonly string[]
}

/**
 * The application's configuration: every value's path and where it came from, and the sources it was loaded from.
 * Values are left out unless the devtools were told to show them, and a shown secret is masked.
 *
 * - `GET /config/properties`: every value
 * - `GET /config/properties/:path`: one value and every layer that set it
 * - `GET /config/sources`: the sources, with when each last loaded and its last failure
 */
export class ConfigTool extends DevTool {
  readonly id = 'config'
  readonly title = 'Configuration'
  readonly description = 'Every configuration value, where it came from, and the sources it was loaded from'
  readonly operations: readonly DevToolOperation[]

  readonly #store: ConfigStore<unknown>
  readonly #showValues: boolean
  readonly #redactor: Redactor

  constructor(store: ConfigStore<unknown>, options: ConfigToolOptions) {
    super()
    this.#store = store
    this.#showValues = options.showValues
    this.#redactor = new Redactor(secretPaths(store.definition.schema), options.redact)
    this.operations = [
      { method: 'GET', path: '/properties', handle: () => this.#properties() },
      { method: 'GET', path: '/properties/:path', handle: ({ params }) => this.#property(params.path) },
      { method: 'GET', path: '/sources', handle: () => this.#sources() },
    ]
  }

  #properties(): PropertyRecord[] {
    return leaves(this.#store.inspect().snapshot).map(([path, value]) => this.#record(path, value))
  }

  #property(path: string): PropertyDetail {
    const found = leaves(this.#store.inspect().snapshot).find(([leaf]) => leaf === path)

    if (found === undefined) {
      throw new ErrDevToolNotFound(`No configuration value at "${path}"`)
    }

    const layers = this.#store.explain(path).layers.map(layer => ({
      layer: layer.layer,
      origin: layer.origin,
      ...(this.#showValues ? { value: this.#layerValue(path, layer.value, found[1]) } : {}),
    }))

    return { ...this.#record(path, found[1]), layers }
  }

  /**
   * A layer's value as it may be shown. A layer holds the text a source gave, so text a codec decoded into an object
   * or an array is read as JSON and masked as the decoded value is; text that is not JSON is masked whole, since
   * nothing tells where its secrets sit.
   */
  #layerValue(path: string, value: unknown, resolved: unknown): unknown {
    if (typeof value !== 'string' || typeof resolved !== 'object' || resolved === null) {
      return this.#redactor.redact(path, value)
    }

    try {
      const decoded: unknown = JSON.parse(value)

      if (typeof decoded === 'object' && decoded !== null) {
        return this.#redactor.redact(path, decoded)
      }
    } catch {
      // Not JSON: masked whole below.
    }

    return REDACTED
  }

  #sources(): SourceRecord[] {
    return this.#store.inspect().sources.map(({ lastError, ...source }) => ({
      ...source,
      ...(lastError === undefined
        ? {}
        : // A driver's error can carry the connection string it failed with.
          { lastError: maskCredentials(lastError instanceof Error ? lastError.message : String(lastError)) }),
    }))
  }

  #record(path: string, value: unknown): PropertyRecord {
    const origin = this.#store.explain(path).layers[0]?.origin ?? 'default'
    const secret = this.#redactor.isSecret(path)

    return { path, origin, secret, ...(this.#showValues ? { value: this.#redactor.redact(path, value) } : {}) }
  }
}

/** Every value of a configuration tree by its dotted path. An array is one value. */
function leaves(tree: unknown, at = ''): Array<[string, unknown]> {
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree) || Object.keys(tree).length === 0) {
    return at === '' ? [] : [[at, tree]]
  }

  return Object.entries(tree).flatMap(([key, value]) => leaves(value, at === '' ? key : `${at}.${key}`))
}
