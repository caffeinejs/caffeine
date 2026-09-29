import { join } from 'node:path'

import { ErrConfig } from '../errors.js'
import { buildTree } from '../merge.js'
import { PROFILES_KEY } from '../profiles.js'
import { splitKey } from '../tree.js'
import type { ConfigLayer, ConfigLoadContext, ConfigSource } from '../types.js'

/** The environment as a plain record, or a function returning one, such as `() => Deno.env.toObject()`. */
export type EnvAccessor = Record<string, string | undefined> | (() => Record<string, string | undefined>)

/**
 * Loads dotenv files into the environment the source reads.
 *
 * It is handed every file the active profiles could name, the most specific first: with `dev` then `prod` active,
 * `.env.prod`, `.env.dev`, then `.env`. The first file to set a variable wins, and a variable that is already set
 * wins over every file, as `process.loadEnvFile` and dotenv have it when handed the list as it is. A loader that
 * overrides lets a file outrank the environment the application was started with.
 *
 * A file that is not there is the loader's to skip.
 */
export type DotenvLoader = (filenames: string[]) => void | Promise<void>

export interface DotenvOptions {
  loader: DotenvLoader
  /** The directory the files are in. */
  path: string
  /** Defaults to `.env`. A profile's file is the base name, a dot and the profile: `.env.dev`. */
  baseName?: string
  /**
   * Whether `${env:NAME}` and `${config:path}` in what the files set are filled in, as in a config file.
   * **Defaults to `true`.** The environment keeps the text as the files wrote it: only the configuration sees the
   * filled-in value.
   *
   * Turn it off for a loader that expands values itself, which would read a placeholder its own way, or to take the
   * files as written.
   */
  interpolate?: boolean
}

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
  /** Defaults to `env`, or `env:<prefix>`. */
  name?: string
  /**
   * Dotenv files, loaded once, before the variables are read. The loader writes into the environment this source
   * reads: `process.env`, unless `env` names another. A placeholder reads `process.env` whatever `env` names.
   */
  dotenv?: DotenvOptions
}

/**
 * Configuration from environment variables: `SHUTDOWN__DRAIN_DELAY` becomes `shutdown.drainDelay`. The separator splits
 * path segments, and underscores within a segment fold into camelCase, so a single-word segment stays as it is.
 *
 * Values stay text. The schema converts them to the types it declares, so `VERSION=1` is `'1'` for a string field
 * and `1` for a number field. A Standard Schema must convert for itself, as `z.coerce.number()` does.
 *
 * An acronym does not survive the folding, `CACHE_TTL` becomes `cacheTtl`: nothing in an upper-case name says
 * where an acronym starts. Reach such a key from the command line, or from a file whose value reads the variable:
 * `TTL: '${env:CACHE_TTL}'`.
 *
 * Without a prefix every variable of the process is read, and only the schema decides which ones count. A variable
 * whose name maps to no path, such as `_` or `__CF_USER_TEXT_ENCODING`, is skipped. So is one whose path another
 * variable uses as a parent, `OTEL__RESOURCE` beside `OTEL__RESOURCE__ATTRIBUTES`, with a warning: the parent wins,
 * and a variable that belongs to some other tool cannot stop the application from starting.
 *
 * What dotenv files set is a layer of its own, below the environment's. The environment's values are never
 * interpolated: one that looks like a placeholder is data.
 */
export class EnvConfigSource implements ConfigSource {
  readonly name: string
  readonly #env: EnvAccessor | undefined
  readonly #prefix: string | undefined
  readonly #separator: string
  readonly #dotenv: DotenvOptions | undefined

  constructor(options: EnvConfigSourceOptions = {}) {
    this.name = options.name ?? (options.prefix ? `env:${options.prefix}` : 'env')
    this.#env = options.env
    this.#prefix = options.prefix
    this.#separator = options.separator ?? '__'
    this.#dotenv = options.dotenv
  }

  /**
   * @throws ErrConfig `ERR_CONFIG_PROFILE` when a dotenv file sets a variable that reaches `caffeine.profiles`: the
   *   profiles were chosen before the files loaded.
   */
  async load(context: ConfigLoadContext): Promise<readonly ConfigLayer[]> {
    const dotenv = this.#dotenv
    let before: ReadonlyMap<string, string | undefined> | undefined

    if (dotenv !== undefined) {
      before = new Map(Object.entries(this.#read()))
      await dotenv.loader(dotenvFiles(dotenv, context.profiles))
    }

    const fromEnv = collected()
    const fromFiles = collected()

    for (const [variable, value] of Object.entries(this.#read())) {
      if (value === undefined || (this.#prefix !== undefined && !variable.startsWith(this.#prefix))) {
        continue
      }

      const parts = splitKey(
        foldKey(this.#prefix === undefined ? variable : variable.slice(this.#prefix.length), this.#separator),
      )
      if (parts.includes('')) {
        continue
      }

      // A file set it: the environment did not hold it, or held something else and the loader overrode it.
      const fromFile = before !== undefined && before.get(variable) !== value
      if (fromFile && parts[0] === PROFILES_KEY[0] && parts[1] === PROFILES_KEY[1]) {
        throw errProfilesFromDotenv(variable)
      }

      const into = fromFile ? fromFiles : fromEnv
      into.entries.push([parts, value])
      into.origins.set(parts.join('.'), `env:${variable}`)
    }

    const env = layer(this.name, fromEnv, context)
    if (dotenv === undefined || fromFiles.entries.length === 0) {
      return [env]
    }

    const files = layer(`dotenv:${dotenvBase(dotenv)}`, fromFiles, context)
    return [{ ...files, interpolate: dotenv.interpolate ?? true }, env]
  }

  #read(): Record<string, string | undefined> {
    return this.#env === undefined ? process.env : typeof this.#env === 'function' ? this.#env() : this.#env
  }
}

interface Collected {
  readonly entries: [string[], string][]
  readonly origins: Map<string, string>
}

function collected(): Collected {
  return { entries: [], origins: new Map() }
}

function layer(name: string, { entries, origins }: Collected, context: ConfigLoadContext): ConfigLayer {
  const data = buildTree(entries, name, path => {
    const key = path.join('.')
    context.logger.warn({ path: key, origin: origins.get(key) }, 'config variable ignored')
    origins.delete(key)
  })

  return { name, data, origins }
}

function dotenvBase({ path, baseName = '.env' }: DotenvOptions): string {
  return join(path, baseName)
}

/** Every file the profiles could name, the most specific first: `.env.prod`, `.env.dev`, then `.env`. */
function dotenvFiles(options: DotenvOptions, profiles: readonly string[]): string[] {
  const base = dotenvBase(options)
  return [...profiles.toReversed().map(profile => `${base}.${profile}`), base]
}

function errProfilesFromDotenv(variable: string): ErrConfig {
  return new ErrConfig(
    `Cannot read "${variable}" from a dotenv file: the active profiles are chosen before any dotenv file loads`,
    'ERR_CONFIG_PROFILE',
    undefined,
    'Name the profiles with CAFFEINE__PROFILES or --caffeine.profiles',
    `Remove "${variable}" from the dotenv files`,
  )
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
