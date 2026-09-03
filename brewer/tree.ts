import type { RouteContract, Routes } from './contract.js'
import type { CallInit, VerbCall } from './init.js'
import type { BrewResponse } from './response.js'
import type { Verb } from './verbs.js'

/** A path split into its segments: `/pets/:id` becomes `['pets', ':id']`, `/` becomes `[]`. */
export type Split<P extends string> = P extends `/${infer Rest}`
  ? Split<Rest>
  : P extends `${infer Head}/${infer Tail}`
    ? [Head, ...Split<Tail>]
    : P extends ''
      ? []
      : [P]

/** A route part-way through the walk: what is left of its path, and the route itself. */
type Entry<S extends readonly string[], R extends RouteContract> = { segs: S; route: R }

/** Any entry, as the constraint every walk step carries. */
type AnyEntry = Entry<readonly string[], RouteContract>

type EntriesOf<R> = R extends RouteContract ? Entry<Split<R['path']>, R> : never

/** The name a parameter segment binds, with the marker, any matching constraint and any `?` stripped. */
type ParamName<H extends string> = H extends '*' ? '*' : H extends `:${infer Rest}` ? StripMarkers<Rest> : never

type StripMarkers<S extends string> = S extends `${infer Name}(${string}`
  ? StripMarkers<Name>
  : S extends `${infer Name}?`
    ? Name
    : S

type Head<E extends AnyEntry> = E extends { segs: readonly [infer H extends string, ...string[]] } ? H : never

/**
 * One node of the client: what ends here, what continues under a name, and what continues under a parameter.
 *
 * Every branch is a filter over the same entry union, so a node costs one pass per kind rather than a traversal
 * each. Intersecting the three means a node can be a terminal and a parent at once, which is what a path like
 * `/pets` and `/pets/:id` needs.
 */
export type Node<E extends AnyEntry> = Terminal<E> & StaticChildren<E> & ParamChild<E>

/** The verbs answered by the routes whose path ends at this node. */
type Terminal<E extends AnyEntry> = {
  [R in Extract<E, { segs: readonly [] }>['route'] as Lowercase<R['method']>]: VerbCall<R>
}

/**
 * The named segments continuing from here.
 *
 * A segment named after a verb is left out: the proxy reads a verb first, so offering it would promise something
 * the runtime cannot deliver. `$request` reaches those.
 */
type StaticChildren<E extends AnyEntry> = {
  [K in Exclude<Extract<Head<E>, string>, `:${string}` | '*' | Verb>]: Node<Advance<E, K>>
}

type Advance<E extends AnyEntry, K extends string> = E extends {
  segs: readonly [K, ...infer T extends readonly string[]]
  route: infer R extends RouteContract
}
  ? Entry<T, R>
  : never

/** Entries whose next segment binds a parameter. */
type ParamEntries<E extends AnyEntry> = E extends { segs: readonly [infer H extends string, ...string[]] }
  ? H extends `:${string}` | '*'
    ? E
    : never
  : never

/**
 * The call that supplies the next path parameter.
 *
 * `Pick` off the route's own params rather than a rebuilt object, so the value keeps the type *and* the optionality
 * the route's schema gave it: `:id` under an integer schema is a `number`, and `:id?` stays optional.
 */
type ParamChild<E extends AnyEntry> = [ParamEntries<E>] extends [never]
  ? unknown
  : (params: ParamArg<ParamEntries<E>>) => Node<AdvanceAny<ParamEntries<E>>>

type ParamArg<E extends AnyEntry> = E extends {
  segs: readonly [infer H extends string, ...string[]]
  route: infer R extends RouteContract
}
  ? Pick<R['params'], Extract<ParamName<H>, keyof R['params']>>
  : never

type AdvanceAny<E extends AnyEntry> = E extends {
  segs: readonly [string, ...infer T extends readonly string[]]
  route: infer R extends RouteContract
}
  ? Entry<T, R>
  : never

/**
 * The escape hatch: a route addressed by method and path.
 *
 * There for the two cases the proxy cannot serve — a path segment named after a verb, and a path decided at run
 * time — and deliberately for nothing else.
 */
export interface RawCall<R extends RouteContract> {
  $request<M extends R['method'], P extends Extract<R, { method: M }>['path']>(
    method: M,
    path: P,
    ...args: RawArgs<Extract<R, { method: M; path: P }>>
  ): Promise<BrewResponse<Extract<R, { method: M; path: P }>['output']>>
}

type RawArgs<R extends RouteContract> =
  Partial<RawInit<R>> extends RawInit<R> ? [init?: RawInit<R>] : [init: RawInit<R>]

type RawInit<R extends RouteContract> = CallInit<R> &
  ([keyof R['params']] extends [never] ? { params?: undefined } : { params: R['params'] })

/** The client: the route tree, plus the escape hatch. */
export type BrewClient<T> = Node<EntriesOf<Routes<T>>> & RawCall<Routes<T>>
