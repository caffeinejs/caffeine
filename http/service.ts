import type { ServiceBootstrapIn } from '@caffeinejs/std'
import { Feats } from './feats.js'
import { AuthenticationOptions } from './security/auth/builder.js'
import { AuthenticationSchemeProvider } from './security/auth/scheme_provider.js'
import { AuthenticationService } from './security/auth/service.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import type { ErrorHandlerProvider } from './error/error.js'
import type { ServerOptions } from './server/server_builder.js'
import type { HealthServices } from './health/services.js'

/** The HTTP application's service kit — the base container kit plus the request feature flags. */
export interface ServiceKit extends ServiceBootstrapIn {
  feats: Feats
}

export interface Services {
  auth: {
    enabled: boolean
    coordinator: AuthenticationService | undefined
    options: AuthenticationOptions | undefined
    schemes: AuthenticationSchemeProvider | undefined
  }
  oidc?: OIDCMeta
  errorHandling: ErrorHandlerProvider
  server: ServerOptions
  health: HealthServices
}

export class ConfigurationContributions {
  constructor(private readonly configurations: Map<symbol, unknown> = new Map()) {
  }

  contribute(key: symbol, value: unknown): this {
    if (this.configurations.has(key)) {
      throw new Error(`Configuration for key ${key.toString()} already exists`)
    }

    this.configurations.set(key, value)
    return this
  }

  contributed(key: symbol): unknown | undefined {
    return this.configurations.get(key)
  }

  // .
  // Builtin
  // .
}
