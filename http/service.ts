import type { ErrorHandlerProvider } from './error/error.js'
import type { HealthServices } from './health/services.js'
import { AuthenticationOptions } from './security/auth/builder.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import { AuthenticationSchemeProvider } from './security/auth/scheme_provider.js'
import { AuthenticationService } from './security/auth/service.js'
import type { ServerOptions } from './server/server_builder.js'

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
