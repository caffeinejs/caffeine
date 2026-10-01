import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { AuthConfig, AuthCredentialsConfig, RefreshTokenConfig } from '../security/auth/config.js'
import { BasicSchemeConfigSchema } from './basic_scheme.js'
import { CookieSchemeConfigSchema } from './cookie_scheme.js'
import { JWTSchemeConfigSchema } from './jwt_scheme.js'
import { OAuthSchemeConfigSchema } from './oauth_scheme.js'
import { OIDCSchemeConfigSchema } from './oidc_scheme.js'
import { OpaqueSchemeConfigSchema } from './opaque_scheme.js'

const ttl = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])

/** `credentials.*`: the identity stamped on a principal built from a username and password. */
const credentialsConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  roleClaimType: $t.Optional($t.String()),
})

type _CredentialsSatisfies = SchemaSatisfies<AuthCredentialsConfig, InferConfig<typeof credentialsConfigSchema>>

/** `refresh.*`: the three token lifetimes. */
const refreshConfigSchema = $t.Object({
  accessTtl: $t.Optional(ttl()),
  refreshTtl: $t.Optional(ttl()),
  absoluteTtl: $t.Optional(ttl()),
})

type _RefreshSatisfies = SchemaSatisfies<RefreshTokenConfig, InferConfig<typeof refreshConfigSchema>>

/**
 * The schema of the authentication configuration block, satisfying {@link AuthConfig}. Hand the node to
 * `Authentication((a, { config }) => a.config(...))`.
 *
 * A scheme's kind is known only to its `addX(...)` call, so each entry under `schemes` accepts every kind's keys
 * and the scheme reads its own. A key no kind declares is dropped when the configuration loads. Declaring the
 * schemes precisely checks each one against its kind instead:
 *
 * ```ts
 * $t.Object({ ...AuthConfigSchema.properties, schemes: $t.Object({ jwt: JWTSchemeConfigSchema }) })
 * ```
 */
export const AuthConfigSchema = $t.Object({
  defaultAuthenticateScheme: $t.Optional($t.String()),
  defaultChallengeScheme: $t.Optional($t.String()),
  defaultForbidScheme: $t.Optional($t.String()),
  schemes: $t.Optional(
    $t.Record(
      $t.String(),
      // OpenID Connect last: its `tokenEndpointAuthMethod` also takes `'auto'`.
      $t.Object({
        ...JWTSchemeConfigSchema.properties,
        ...BasicSchemeConfigSchema.properties,
        ...OpaqueSchemeConfigSchema.properties,
        ...CookieSchemeConfigSchema.properties,
        ...OAuthSchemeConfigSchema.properties,
        ...OIDCSchemeConfigSchema.properties,
      }),
    ),
  ),
  credentials: $t.Optional(credentialsConfigSchema),
  refresh: $t.Optional(refreshConfigSchema),
})

type _Satisfies = SchemaSatisfies<AuthConfig, InferConfig<typeof AuthConfigSchema>>
