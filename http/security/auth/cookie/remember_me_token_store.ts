import { SeriesTokenStore } from '../internal/series_token.js'

/**
 * Persists durable remember-me credentials so they survive session expiry and can be revoked server-side.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the base class.
 * Extend it and bind the concrete type (`bind(DbRememberStore).toSelf().extends()`), like `OpaqueTokenStore` /
 * `UserProvider`. The contract is {@link SeriesTokenStore}'s; this class only gives the remember-me credentials a
 * token of their own, so an application can keep them apart from its refresh tokens.
 */
export abstract class RememberMeTokenStore extends SeriesTokenStore {}
