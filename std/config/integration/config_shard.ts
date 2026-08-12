import { kSelfRefresh, type SelfRefreshable } from '@caffeinejs/di'
import type { ConfigBootstrapResult, BootstrapOptions } from '../bootstrap.js'
import { bootstrapConfig } from '../bootstrap.js'
import type { ConfigHandle } from '../config_accessor.js'
import { createLiveAccessors } from '../config_accessor.js'
import type { ConfigDiagnostics } from '../config_diagnostics.js'
import { createConfigDiagnostics } from '../config_diagnostics.js'
import type { ConfigSnapshot } from '../types.js'

export class ConfigShard<T> implements SelfRefreshable {
  #validated: T
  #snapshot: ConfigSnapshot
  readonly #options: BootstrapOptions<T>
  readonly handle: ConfigHandle<T>

  static async bootstrap<T>(options: BootstrapOptions<T>): Promise<ConfigShard<T>> {
    const result = await bootstrapConfig(options)
    return new ConfigShard(result, options)
  }

  private constructor(result: ConfigBootstrapResult<T>, options: BootstrapOptions<T>) {
    this.#validated = result.validated
    this.#snapshot = result.snapshot
    this.#options = options
    this.handle = createLiveAccessors(() => this.#validated)
  }

  get diagnostics(): ConfigDiagnostics {
    return createConfigDiagnostics(this.#validated, this.#snapshot)
  }

  async [kSelfRefresh](): Promise<void> {
    const result = await bootstrapConfig(this.#options)
    this.#validated = result.validated
    this.#snapshot = result.snapshot
  }

  async dispose(): Promise<void> {
    await Promise.all(this.#options.providers.map(p => p.dispose?.()))
  }
}
