import type { RouteContract } from './contract.js'

/**
 * The `Response` a call answers with, with `json()` typed to what the route returns.
 *
 * Everything else `Response` gives — `ok`, `status`, `headers`, `text()`, `body` — is untouched, and checking the
 * status stays with the caller. A route that answers with text, bytes, a file, a stream or a whole `Response` sends
 * it as it is rather than as JSON, so its `json()` is `unknown`: read it with `text()`, `bytes()`, `blob()` or `body`.
 */
export type BrewResponse<T> = Omit<Response, 'json'> & { json(): Promise<JSONOf<T>> }

/**
 * The `Response` a call answers with when the status is known, so `json()` is the body that goes with that status.
 *
 * Reached by checking `status`, never on its own: it is one member of the union {@link BrewResponseOf} builds.
 */
export type BrewStatusResponse<S extends number, T> = Omit<Response, 'json' | 'status'> & {
  readonly status: S
  json(): Promise<JSONOf<T>>
}

// What `json()` yields for a body typed `T`: `T` itself when the server encodes it as JSON, and `unknown` when the
// server sends it as it is. `never` stays `never`, which keeps the open member of `BrewResponseOf` narrowable, and
// `any` stays `any`.
type JSONOf<T> = 0 extends 1 & T ? T : [Extract<T, Unencoded>] extends [never] ? T : unknown

// A body the server writes as it is: text, bytes, a file, a stream, a whole `Response`, or a responder that writes its
// own, such as an HTML page. A Node stream is matched by being async iterable, which no JSON value is.
type Unencoded =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream
  | Response
  | AsyncIterable<unknown>
  | { respond(...args: never[]): unknown }

/**
 * What one call answers with: a member per status the route declared, so checking the status types the body.
 *
 * ```ts
 * const res = await client.pets({ id: 1 }).get()
 *
 * if (res.status === 200) {
 *   const pet = await res.json()      // the 200 schema
 * } else if (res.status === 404) {
 *   const problem = await res.json()  // the 404 schema
 * }
 * ```
 *
 * A route that declares no response schema answers {@link BrewResponse}, typed from the handler's return — the
 * status is then plain `number` and there is nothing to narrow.
 *
 * The union carries one further member for a status the route did not declare, which a framework 500 is. Its
 * `status` is `number`, so comparing against an undeclared code still compiles rather than failing as a
 * non-overlapping comparison; its body is `never`, because the route said nothing about it. That `never` is also
 * what keeps the declared members narrowable — a fallback carrying a body would be reachable from every
 * comparison and would widen `json()` back to a union.
 */
export type BrewResponseOf<R extends RouteContract> = [StatusOf<R>] extends [never]
  ? BrewResponse<R['output']>
  : { [S in StatusOf<R>]: BrewStatusResponse<S, R['responses'][S]> }[StatusOf<R>] | BrewResponse<never>

/** The status codes a route declared a response schema for. */
type StatusOf<R extends RouteContract> = Extract<keyof R['responses'], number>
