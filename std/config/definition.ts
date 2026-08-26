import { secretPaths } from './secrets.js'
import { ConfigSlice, type ConfigSliceSpec } from './slice.js'
import { ConfigPriority, ConfigSources } from './sources.js'
import { ErrConfig } from './errors.js'
import { MutableConfigProvider } from './providers/mutable_provider.js'
import { type ConfigSchema, passthroughConfigSchema } from './schema.js'
import type { ResolutionContext } from './types.js'

/** DI key for the {@link ConfigDefinition} the application builder owns. Features resolve it to register a slice. */
export const kConfigDefinition = Symbol.for('@caffeinejs/std:config.definition')

const DEFAULT_CONTEXT = (): ResolutionContext => ({ app: 'application', profiles: ['default'] })

/**
 * The live description of an application's configuration: its sources, its root schema, its resolution context,
 * and the feature slices carved out of the resulting tree.
 *
 * Live is the whole point. The previous design snapshotted the provider list when `.config()` was called, which
 * meant nothing registered afterwards could ever be seen — and feature builders necessarily run afterwards, at
 * `kServiceConfigure`. Holding one mutable definition that the config module reads at `container.init()` lets
 * the application builder, every feature, and `run(argv)` all contribute to the same tree, in whatever order
 * they happen to run.
 */
export class ConfigDefinition {
  readonly token: symbol
  readonly sources = new ConfigSources()
  readonly slices: ConfigSliceSpec[] = []

  /** Framework defaults — the bottom of the chain. Everything overrides these. */
  readonly frameworkDefaults = new MutableConfigProvider('framework-defaults')
  /** Values set through feature builder methods. Defaults too: file, env and args all win over them. */
  readonly codeValues = new MutableConfigProvider('code')

  schema: ConfigSchema<unknown> = passthroughConfigSchema
  context: ResolutionContext = DEFAULT_CONTEXT()
  failFast: boolean | undefined
  /**
   * The command-line arguments, once `run(argv)` has handed them over. Held here rather than on the context
   * because only the args source reads them, and it is built by `.args()` long before they arrive — so it
   * takes a closure over this field instead of a value captured empty.
   */
  argv: readonly string[] | undefined
  /**
   * Paths marked with `$t.Secret`, collected as each slice registers and from the root schema at bootstrap.
   * Read by the diagnostics, which redact them; nothing on a feature's own read path consults this.
   */
  readonly secrets = new Set<string>()
  /**
   * Reports a refresh that failed for one feature. The application builder points this at the host's warning
   * channel; `std/config` never reaches for one itself, so it stays free of any host dependency.
   */
  warn: ((message: string) => void) | undefined
  #bootstrapped = false

  constructor(token: symbol) {
    this.token = token
    this.sources.add(this.frameworkDefaults, ConfigPriority.FRAMEWORK)
    this.sources.add(this.codeValues, ConfigPriority.CODE)
  }

  /** Whether the configuration has been resolved. After this, changes need a refresh to take effect. */
  get bootstrapped(): boolean {
    return this.#bootstrapped
  }

  /** Framework-internal: marks the definition resolved, called by the config module. */
  markBootstrapped(): void {
    this.#bootstrapped = true
  }

  /**
   * Records the command-line arguments for the args source to read.
   *
   * Applying them once configuration is already resolved would be a silent no-op — the flags the operator
   * typed would simply not be there — so it throws instead.
   */
  setArgv(argv: readonly string[]): void {
    if (this.#bootstrapped) {
      throw new ErrConfig(
        'Cannot apply command-line arguments: the application is already initialized',
        'ERR_CONFIG_ARGS_TOO_LATE',
        undefined,
        'Call "run(argv)" instead of initializing the container yourself, so the arguments are recorded first',
        'Move any explicit "container.init()" after the arguments have been handed to the application',
      )
    }
    this.argv = argv
  }

  /**
   * Registers a feature slice and returns the holder its validated value is published into, on bootstrap and
   * on every refresh. `parts` is pre-split so no read path ever parses a dotted key.
   */
  slice<T>(parts: readonly string[], schema: ConfigSchema<T>): ConfigSlice<T> {
    for (const path of secretPaths(schema, parts)) {
      this.secrets.add(path)
    }

    // The warning channel is read lazily: features register their slices at `kServiceConfigure`, and the
    // application builder points `warn` at the host separately. Passing it by value here would capture whatever
    // it happened to be — usually nothing.
    const slice = new ConfigSlice<T>(parts, () => this.warn)
    this.slices.push({ parts, schema, slice } as ConfigSliceSpec)
    return slice
  }
}
