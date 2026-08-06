import type { Context } from '../../../context.js'
import type { Principal } from '../../index.js'

/**
 * Server-side lookup for opaque (non-JWT) bearer tokens.
 *
 * Declared as an abstract class rather than an interface so it is a runtime value: it doubles as the
 * DI token and the base class. Extend it with your own implementation and bind that implementation to
 * the `OpaqueTokenStore` token, and the opaque scheme resolves it from the container automatically.
 *
 * ```ts
 * class DbOpaqueTokenStore extends OpaqueTokenStore {
 *   async validate(token: string) { ... }
 * }
 *
 * container.bind(DbOpaqueTokenStore).toSelf().extends()
 * builder.authentication.addOpaqueToken()
 * ```
 *
 * The store owns hashing, lookup, revocation and expiry: return `null` for any token that is unknown,
 * revoked, or expired. It builds the `Principal` itself (roles, `scope` claims, etc.) via the
 * `Identity`/`Claim`/`Principal` API, mirroring an ASP.NET Core handler producing a `ClaimsPrincipal`.
 */
export abstract class OpaqueTokenStore {
  abstract validate(token: string, ctx: Context): Promise<Principal | null> | Principal | null
}
