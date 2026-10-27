import type { ConfigStore } from '@caffeinejs/application/config'
import { ErrHTTPNotFound } from '@caffeinejs/http'

import type { ToolInfo } from '../tool.js'
import type { PropertyDetail, PropertyRecord, SourceRecord } from './config.schema.js'
import { maskCredentials, REDACTED, Redactor, secretPaths } from './redact.js'

export const configTool: ToolInfo = {
  id: 'config',
  title: 'Configuration',
  description: 'Every configuration value, where it came from, and the sources it was loaded from',
}

export interface ConfigToolOptions {
  /** Show values, secrets masked. Without it, a property names its path and origin only. */
  readonly showValues: boolean
  /** Paths to mask besides what the schema and the key names mark. */
  readonly redact: readonly string[]
}

/**
 * Reads the configuration as the devtools show it. Values are left out unless the devtools were told to show them,
 * and a shown secret is masked.
 */
export class ConfigTool {
  readonly #store: ConfigStore<unknown>
  readonly #showValues: boolean
  readonly #redactor: Redactor

  constructor(store: ConfigStore<unknown>, options: ConfigToolOptions) {
    this.#store = store
    this.#showValues = options.showValues
    this.#redactor = new Redactor(secretPaths(store.definition.schema), options.redact)
  }

  properties(): PropertyRecord[] {
    return leaves(this.#store.inspect().snapshot).map(([path, value]) => this.#record(path, value))
  }

  /** @throws ErrHTTPNotFound when the configuration holds no value at `path`. */
  property(path: string): PropertyDetail {
    const found = leaves(this.#store.inspect().snapshot).find(([leaf]) => leaf === path)

    if (found === undefined) {
      throw new ErrHTTPNotFound(`No configuration value at "${path}"`)
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

  sources(): SourceRecord[] {
    return this.#store.inspect().sources.map(({ lastError, ...source }) => ({
      ...source,
      layers: [...source.layers],
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
