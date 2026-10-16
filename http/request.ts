import type { AnySchema, InferSchema } from '@caffeinejs/std/schema'

import type { CookieSecret, CookieUnsignResult } from './core/cookie/signer.js'
import type { RouteValidationSchema } from './core/routing/spec.js'

export type UnsignedCookie = string | false | undefined

export interface IRequest<
  RAW = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  THeaders = Record<string, string>,
  TAsync extends boolean = false,
  TBody = unknown,
> {
  get raw(): RAW

  /** The request's path and query as the application sees it: without the {@link basePath} the server took off. */
  get url(): string

  /**
   * What the server took off the front of the request's path before routing it — the application's
   * `.basePath(...)` — or `''` when there is none, or when the request came without it.
   *
   * A URL the browser is sent to puts it back — `ctx.redirect('~/signed-out')` does it for a redirect, and
   * `ctx.req.basePath + '/signed-out'` anywhere else, such as a link in a page.
   */
  get basePath(): string

  get method(): string

  /**
   * The authority the server trusts for this request, `host[:port]`: the `Host` header, `:authority` over HTTP/2,
   * or `X-Forwarded-Host` behind a proxy the server was told to trust (`trustProxy`).
   */
  get host(): string

  /**
   * The scheme, lower-cased: `https` or `http` as the socket says, or `X-Forwarded-Proto` behind a proxy the server
   * was told to trust (`trustProxy`). Empty when neither says.
   */
  get protocol(): string

  /**
   * The parsed request body, as the adapter's content-type parser produced it, typed by the route's `body`
   * schema when it declares one.
   *
   * A handler that takes its arguments through pickers reaches the body with `$p.body()` instead; this is the
   * accessor for one that receives only the context.
   */
  body(): TBody

  query(): TQuery
  query(key: string): string | undefined

  queries(key: string): string[] | undefined

  header(): THeaders
  header(key: string): string | undefined

  hasHeader(key: string): boolean

  param(): TParams
  param(key: string): string | undefined

  /**
   * The cookies the request carries, parsed on first read. Of two sharing a name, the first wins: a browser sends
   * the more specific one first.
   *
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  cookie(): Record<string, string>
  cookie(name: string): string | undefined

  /**
   * Every cookie the request carries, verified with the server's signer: the value, or `false` for one that does not
   * verify. A cookie signed with a secret of its own reads as `false` here.
   */
  signedCookie(): TAsync extends true ? Promise<Record<string, UnsignedCookie>> : Record<string, UnsignedCookie>
  /**
   * The value a signed cookie carries, `false` when it does not verify, or `undefined` when the request did not send
   * it.
   *
   * `secret` verifies with that secret instead of the server's signer, the one `ctx.cookie(name, value, { secret })`
   * signed with. An array rotates: any of its entries verifies.
   *
   * @throws ErrCookieConfiguration when there is no secret to verify with.
   */
  signedCookie(name: string, secret?: CookieSecret): TAsync extends true ? Promise<UnsignedCookie> : UnsignedCookie

  /**
   * Verifies a signed value, a cookie's as the request carries it, and says what the verifying found: `{ valid, renew,
   * value }`, or `{ valid: false, renew: false, value: null }` for one that does not verify.
   *
   * `renew` says a secret other than the first verified it. Set the cookie again, with the options it was set with,
   * and it goes out signed with the first: an older secret can then be retired while its cookies are still in use.
   * `secret` verifies with that secret instead of the server's signer, as in {@link signedCookie}.
   *
   * @example
   * ```ts
   * const result = await ctx.req.unsignCookie(ctx.req.cookie('session') ?? '')
   *
   * if (result.valid && result.renew) {
   *   ctx.cookie('session', result.value, { path: '/', signed: true })
   * }
   * ```
   *
   * @throws ErrCookieConfiguration when there is no secret to verify with.
   * @throws ErrCookiesDisabled when the server has cookies off.
   */
  unsignCookie(
    value: string,
    secret?: CookieSecret,
  ): TAsync extends true ? Promise<CookieUnsignResult> : CookieUnsignResult
}

/**
 * Derives the type of a request slot from the schema declared for it, falling back to `Fallback` when the route
 * declares nothing for that slot.
 *
 * ```ts
 * const PetRoute = { params: $t.Object({ id: $t.Integer() }) }
 *
 * // ctx.req.param() is { id: number }
 * handler(ctx: Context<Vars, typeof PetRoute>) { ... }
 * ```
 *
 * Inference reads the *authored* schema, so it reflects what the author wrote — not the per-slot strictness
 * the route compilation adds on top.
 */
export type InferSlot<S, Slot extends keyof RouteValidationSchema, Fallback> =
  S extends Record<Slot, infer Schema extends AnySchema> ? InferSchema<Schema> : Fallback

export type InferParams<S> = InferSlot<S, 'params', Record<string, string>>
export type InferQuery<S> = InferSlot<S, 'querystring', Record<string, string>>
export type InferHeaders<S> = InferSlot<S, 'headers', Record<string, string>>
export type InferBody<S> = InferSlot<S, 'body', unknown>
