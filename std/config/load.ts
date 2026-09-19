import type { Logger } from '../logger/logger.js'
import { noopLogger } from '../logger/noop.js'
import { activeProfiles } from './profiles.js'
import { ConfigStore, kFirstLoad } from './store.js'
import type { ConfigDefinition } from './types.js'

/** How long one load of one source may take, unless the definition says otherwise. */
export const DEFAULT_LOAD_TIMEOUT_MS = 30_000

export interface LoadConfigOptions {
  /** The active profiles. Duplicates and blanks are dropped. */
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
 * Loads a configuration: every source, merged, validated and frozen, ready to read.
 *
 * @throws ErrConfig `ERR_CONFIG_DUPLICATE_SOURCE`, `ERR_CONFIG_SOURCE`, `ERR_CONFIG_SOURCE_TIMEOUT`, or a source's own
 *   `ErrConfig`, when a source cannot be registered or loaded.
 * @throws ErrConfigValidation when the merged configuration does not satisfy the schema.
 */
export async function loadConfig<T>(
  definition: ConfigDefinition<T>,
  options: LoadConfigOptions = {},
): Promise<ConfigStore<T>> {
  const given = options.logger
  const logger = typeof given === 'function' ? given : () => given ?? noopLogger

  const store = new ConfigStore<T>(definition, { profiles: activeProfiles(options.profiles ?? []), logger })
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
