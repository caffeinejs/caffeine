import { Container } from '@caffeinejs/di'
import { Feats } from './feats.js'
import { AuthenticationOptions } from './security/auth/builder.js'
import { AuthenticationService } from './security/auth/service.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'

export interface ServiceKit {
  container: Container
  feats: Feats
}

export const kServiceConfigure = Symbol('configure')

export interface Service {
  [kServiceConfigure](kit: ServiceKit): Promise<void>
}

export interface Services {
  auth: {
    enabled: boolean
    coordinator: AuthenticationService | undefined
    options: AuthenticationOptions | undefined
  }
  authz: {
    enabled: boolean
  }
  oidc?: OIDCMeta
}
