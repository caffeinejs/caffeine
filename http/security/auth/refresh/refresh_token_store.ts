import { SeriesTokenStore } from '../internal/series_token.js'

/**
 * Persists durable refresh tokens for the bearer refresh-token grant so they survive access-token expiry and can be
 * revoked server-side.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the base class.
 * Extend it and bind the concrete type (`bind(DbRefreshStore).toSelf().extends()`), like `OpaqueTokenStore` /
 * `UserProvider` / `RememberMeTokenStore`. The contract is {@link SeriesTokenStore}'s; this class only gives the
 * refresh tokens a token of their own.
 */
export abstract class RefreshTokenStore extends SeriesTokenStore {}
