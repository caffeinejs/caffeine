import type { RouteContract } from './contract.js'

/**
 * The `Response` a call answers with, with `json()` typed to what the route returns.
 *
 * Everything else `Response` gives — `ok`, `status`, `headers`, `text()`, `body` — is untouched, and checking the
 * status stays with the caller.
 */
export type BrewResponse<T> = Omit<Response, 'json'> & { json(): Promise<T> }

/**
 * The `Response` a call answers with when the status is known, so `json()` is the body that goes with that status.
 *
 * Reached by checking `status`, never on its own: it is one member of the union {@link BrewResponseOf} builds.
 */
export type BrewStatusResponse<S extends number, T> = Omit<Response, 'json' | 'status'> & {
  readonly status: S
  json(): Promise<T>
}

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
