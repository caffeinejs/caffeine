import type { ConfigStore } from '@caffeinejs/application/config'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { blend, ErrHTTPNotFound, Router } from '@caffeinejs/http'

import { ErrorSchema, type ToolInfo } from '../tool.js'
import { maskCredentials, REDACTED, Redactor, secretPaths } from './redact.js'

/** One configuration value, and where it came from. */
export const PropertySchema = $t.Object({
  /** The dotted path, `db.url`. */
  path: $t.String(),
  /** What set it: `env:DB_URL`, a file, a layer's name; `default` for a schema default. */
  origin: $t.String(),
  /** Masked when shown: a `$t.Secret` field, a path naming a secret, or one `redact(...)` names. */
  secret: $t.Boolean(),
  /** Present only when the devtools were told to show values, with every secret masked. */
  value: $t.Optional($t.Unknown()),
})

/** One value and every layer that set it, winner first. */
export const PropertyDetailSchema = $t.Object({
  ...PropertySchema.properties,
  layers: $t.Array($t.Object({ layer: $t.String(), origin: $t.String(), value: $t.Optional($t.Unknown()) })),
})

/** A configuration source, as the store last loaded it. */
export const SourceSchema = $t.Object({
  name: $t.String(),
  trigger: $t.String(),
  layers: $t.Array($t.String()),
  keys: $t.Integer(),
  /** In milliseconds since the epoch; `0` before a load has succeeded. */
  lastLoadedAt: $t.Number(),
  /** A duration, in milliseconds. */
  lastLoadDuration: $t.Number(),
  consecutiveFailures: $t.Integer(),
  /** The message of the last failure, the password of any URL in it masked. */
  lastError: $t.Optional($t.String()),
})

export type PropertyRecord = InferSchema<typeof PropertySchema>
export type PropertyDetail = InferSchema<typeof PropertyDetailSchema>
export type SourceRecord = InferSchema<typeof SourceSchema>

export interface ConfigToolOptions {
  /** Show values, secrets masked. Without it, a property names its path and origin only. */
  readonly showValues: boolean
  /** Paths to mask besides what the schema and the key names mark. */
  readonly redact: readonly string[]
}

export const configTool: ToolInfo = {
  id: 'config',
  title: 'Configuration',
  description: 'Every configuration value, where it came from, and the sources it was loaded from',
}

/**
 * The application's configuration: every value's path and where it came from, and the sources it was loaded from.
 *
 * - `GET /config/properties`: every value
 * - `GET /config/properties/:path`: one value and every layer that set it
 * - `GET /config/sources`: the sources, with when each last loaded and its last failure
 */
export function configRouter(tool: ConfigTool) {
  const config = new Router('/config')

  const properties = config
    .get('/properties')
    .schema({ response: { 200: $t.Array(PropertySchema) } })
    .handler(() => tool.properties())

  const property = config
    .get('/properties/:path')
    .schema({ response: { 200: PropertyDetailSchema, 404: ErrorSchema } })
    .handler(ctx => tool.property(ctx.req.param().path))

  const sources = config
    .get('/sources')
    .schema({ response: { 200: $t.Array(SourceSchema) } })
    .handler(() => tool.sources())

  return blend(properties, property, sources)
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
