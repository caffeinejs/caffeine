import type { ServiceKit as BaseServiceKit } from '@caffeinejs/std'
import { Feats } from './feats.js'
import { AuthenticationOptions } from './security/auth/builder.js'
import { AuthenticationService } from './security/auth/service.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import type { ErrorHandlerProvider } from './error/error.js'
import type { ServerOptions } from './server/server_builder.js'
import type { HealthServices } from './health/services.js'

/** The HTTP application's service kit — the base container kit plus the request feature flags. */
export interface ServiceKit extends BaseServiceKit {
  feats: Feats
}

export interface Services {
  auth: {
    enabled: boolean
    coordinator: AuthenticationService | undefined
    options: AuthenticationOptions | undefined
  }
  oidc?: OIDCMeta
  errorHandling: ErrorHandlerProvider
  server: ServerOptions
  health: HealthServices
}
