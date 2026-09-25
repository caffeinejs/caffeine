import { buildTree } from '../merge.js'
import { splitKey } from '../tree.js'
import type { ConfigLayer, ConfigLoadContext, ConfigSource } from '../types.js'

/** The environment as a plain record, or a function returning one, such as `() => Deno.env.toObject()`. */
export type EnvAccessor = Record<string, string | undefined> | (() => Record<string, string | undefined>)

export interface EnvConfigSourceOptions {
  /**
   * Where the variables are read from. Defaults to `process.env`. Pass the runtime's own accessor and nothing
   * reaches for a global; it is also what a test supplies instead of changing the real environment.
   */
  env?: EnvAccessor
  /** Only variables starting with this are read, and the prefix is removed from the key. */
  prefix?: string
  /** Splits a variable name into path segments. Defaults to `__`. */
  separator?: string
  /** Turns a variable name, prefix removed, into a dotted path. Replaces the default folding entirely. */
  transformKey?: (key: string) => string
  /** Defaults to `env`, or `env:<prefix>`. */
  name?: string
}

/**
 * Configuration from environment variables: `SHUTDOWN__DRAIN_DELAY` becomes `shutdown.drainDelay`. The separator splits
 * path segments, and underscores within a segment fold into camelCase, so a single-word segment stays as it is.
 *
 * Values stay text. The schema converts them to the types it declares, so `VERSION=1` is `'1'` for a string field
 * and `1` for a number field. A Standard Schema must convert for itself, as `z.coerce.number()` does.
 *
 * An acronym does not survive the folding, `CACHE_TTL` becomes `cacheTtl`: nothing in an upper-case name says
 * where an acronym starts. Reach such a key from a file, the command line, or {@link EnvConfigSourceOptions.transformKey}.
 *
 * Without a prefix every variable of the process is read, and only the schema decides which ones count. A variable
 * whose name maps to no path, such as `_` or `__CF_USER_TEXT_ENCODING`, is skipped. So is one whose path another
 * variable uses as a parent, `OTEL__RESOURCE` beside `OTEL__RESOURCE__ATTRIBUTES`, with a warning: the parent wins,
 * and a variable that belongs to some other tool cannot stop the application from starting.
 */
export class EnvConfigSource implements ConfigSource {
  readonly name: string
  readonly #env: EnvAccessor | undefined
  readonly #prefix: string | undefined
  readonly #transformKey: (key: string) => string

  constructor(options: EnvConfigSourceOptions = {}) {
    const separator = options.separator ?? '__'

    this.name = options.name ?? (options.prefix ? `env:${options.prefix}` : 'env')
    this.#env = options.env
    this.#prefix = options.prefix
    this.#transformKey = options.transformKey ?? (key => foldKey(key, separator))
  }

  load(context: ConfigLoadContext): readonly ConfigLayer[] {
    const env = this.#env === undefined ? process.env : typeof this.#env === 'function' ? this.#env() : this.#env
    const entries: [string[], string][] = []
    const origins = new Map<string, string>()

    for (const [variable, value] of Object.entries(env)) {
      if (value === undefined || (this.#prefix !== undefined && !variable.startsWith(this.#prefix))) {
        continue
      }

      const parts = splitKey(
        this.#transformKey(this.#prefix === undefined ? variable : variable.slice(this.#prefix.length)),
      )
      if (parts.includes('')) {
        continue
      }
      entries.push([parts, value])
      origins.set(parts.join('.'), `env:${variable}`)
    }

    const data = buildTree(entries, this.name, path => {
      const key = path.join('.')
      context.logger.warn({ path: key, origin: origins.get(key) }, 'config variable ignored')
      origins.delete(key)
    })

    return [{ name: this.name, data, origins }]
  }
}

function foldKey(key: string, separator: string): string {
  return key
    .split(separator)
    .map(segment => camelCase(segment.toLowerCase()))
    .join('.')
}

function camelCase(segment: string): string {
  return segment
    .split('_')
    .map((word, i) => (i === 0 || word === '' ? word : word[0].toUpperCase() + word.slice(1)))
    .join('')
}
