import type { Logger } from '../logger/logger.js'
import { noopLogger } from '../logger/noop.js'
import { loadDotenv } from './dotenv.js'
import { activeProfiles, hostProfiles } from './profiles.js'
import { ConfigStore, kFirstLoad } from './store.js'
import type { ConfigDefinition } from './types.js'

/** How long one load of one source may take, unless the definition says otherwise. */
export const DEFAULT_LOAD_TIMEOUT_MS = 30_000

export interface LoadConfigOptions {
  /**
   * The profiles named in code. The host's follow them: `--caffeine.profiles`, or else `CAFFEINE_PROFILES`, which the
   * base dotenv file may set. Duplicates and blanks are dropped.
   */
  profiles?: readonly string[]
  /**
   * Where the store logs. A function is called on every event, so a logger replaced after start-up is followed.
   * Omitted, nothing is logged.
   */
  logger?: Logger | (() => Logger)
  /** Whether to arm the poll timers and the watchers now. Defaults to `true`. */
  start?: boolean
}

/**
 * Loads a configuration: the dotenv files first, then every source, merged, validated and frozen, ready to read.
 *
 * @throws ErrConfig `ERR_CONFIG_DOTENV` when the dotenv loader fails, `ERR_CONFIG_INTERPOLATION` when what the dotenv
 *   files set cannot be expanded, or `ERR_CONFIG_PROFILE` when a profile is `.` or `..`, or holds `/` or `\`.
 * @throws ErrConfig `ERR_CONFIG_DUPLICATE_SOURCE`, `ERR_CONFIG_SOURCE`, `ERR_CONFIG_SOURCE_TIMEOUT`, or a source's own
 *   `ErrConfig`, when a source cannot be registered or loaded.
 * @throws ErrConfigValidation when a placeholder cannot be interpolated, or the merged configuration does not
 *   satisfy the schema.
 */
export async function loadConfig<T>(
  definition: ConfigDefinition<T>,
  options: LoadConfigOptions = {},
): Promise<ConfigStore<T>> {
  const given = options.logger
  const logger = typeof given === 'function' ? given : () => given ?? noopLogger

  // Read once the base dotenv file has loaded, so a `CAFFEINE_PROFILES` it sets names profiles too.
  const named = options.profiles ?? []
  const profilesOf = (): string[] => activeProfiles([...named, ...hostProfiles()])
  const profiles = definition.dotenv === undefined ? profilesOf() : await loadDotenv(definition.dotenv, profilesOf)

  const store = new ConfigStore<T>(definition, { profiles, logger })
  try {
    await store[kFirstLoad]()
  } catch (error) {
    // Nobody receives a store that failed to load, so nobody else could close the sources that did load.
    await store.close()
    throw error
  }

  if (options.start !== false) {
    store.start()
  }

  return store
}
