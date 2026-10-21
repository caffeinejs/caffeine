import type { RouteContract, Routes } from './contract.js'
import type { FileHelpers } from './files.js'
import type { CallInit, VerbCall } from './init.js'
import type { BrewResponseOf } from './response.js'
import type { Verb } from './verbs.js'

/**
 * A path split into its segments: `/pets/:id` becomes `['pets', ':id']`, `/` becomes `[]`.
 *
 * Splits on every `/`, so a parameter whose matching constraint contains one — `:id(\d+/\d+)` — is split inside
 * the constraint and the segment is misread. `$request` addresses such a route by its literal path.
 */
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

/**
 * The name a segment binds when it is that parameter alone, read from the path as the router reads it: `*`, or
 * `:id` followed by a matching constraint or an optional `?`. `never` for a segment with a second parameter or text
 * of its own, such as `:lat-:lng`, `:name.json` or `:id(^\d+)?`, whose `?` the router reads as text.
 *
 * Read from the path alone, never from the route's params: a schema that declares no keys says nothing about it.
 */
type LoneName<H extends string> = H extends '*' ? '*' : H extends `:${infer S}` ? Lone<OptionalBody<S>> : never

// The router reads a trailing `?` as optional only on a segment that holds no constraint.
type OptionalBody<S extends string> = S extends `${infer Body}?`
  ? S extends `${string}${'(' | ')'}${string}`
    ? S
    : Body
  : S

// The name `S` starts with, when nothing but a constraint follows it.
type Lone<S extends string> = S extends `${ParamName<S>}${infer Rest}`
  ? Rest extends ''
    ? ParamName<S>
    : IsConstraint<Rest> extends true
      ? ParamName<S>
      : never
  : never

// A name ends at `(`, `-` or `.`, as the router ends it.
type ParamName<S extends string> = Before<Before<Before<S, '('>, '-'>, '.'>

type Before<S extends string, C extends string> = S extends `${infer Head}${C}${string}` ? Head : S

// Whether `S` is one constraint and nothing after it: its first `(` balanced by its last character, as the router
// balances parentheses, nested ones counted and a `\` escaping the character after it.
type IsConstraint<S extends string, Open extends 0[] = []> = S extends `${infer C}${infer Rest}`
  ? C extends '\\'
    ? IsConstraint<Rest extends `${string}${infer Escaped}` ? Escaped : '', Open>
    : C extends '('
      ? IsConstraint<Rest, [...Open, 0]>
      : C extends ')'
        ? Open extends [0]
          ? Rest extends ''
            ? true
            : false
          : Open extends [0, ...infer Outer extends 0[]]
            ? IsConstraint<Rest, Outer>
            : false
        : Open extends []
          ? false
          : IsConstraint<Rest, Open>
  : false

type Head<E extends AnyEntry> = E extends { segs: readonly [infer H extends string, ...string[]] } ? H : never

/**
 * One node of the client: what ends here, what continues under a name, and what continues under a parameter.
 *
 * Every branch is a filter over the same entry union, so a node costs one pass per kind rather than a traversal
 * each. Intersecting the three means a node can be a terminal and a parent at once, which is what a path like
 * `/pets` and `/pets/:id` needs. `Reserved` names the segments a node answers itself, as the root does `$request`.
 */
export type Node<E extends AnyEntry, Reserved extends string = never> = Terminal<E> &
  StaticChildren<E, Reserved> &
  ParamChild<E>

/**
 * The verbs answered by the routes whose path ends at this node.
 *
 * Only methods the proxy has a verb for: it would read any other name as a segment. `$request` sends those.
 */
type Terminal<E extends AnyEntry> = {
  [R in Extract<E, { segs: readonly [] }>['route'] as Extract<Lowercase<R['method']>, Verb>]: VerbCall<R>
}

/**
 * The named segments continuing from here.
 *
 * A segment named after a verb is left out: the proxy reads a verb first, so offering it would promise something
 * the runtime cannot deliver. So is one named `then`, which the proxy never answers, so that a client is never
 * taken for a promise, and one the node reserves, as the root does `$request`. So is one holding a `:`: `v:version`
 * holds a parameter, and the router matches `a::b` as `a:b`. `$request` reaches them all.
 */
type StaticChildren<E extends AnyEntry, Reserved extends string> = {
  [K in Exclude<Extract<Head<E>, string>, `${string}:${string}` | '*' | Verb | 'then' | Reserved>]: Node<Advance<E, K>>
}

type Advance<E extends AnyEntry, K extends string> = E extends {
  segs: readonly [K, ...infer T extends readonly string[]]
  route: infer R extends RouteContract
}
  ? Entry<T, R>
  : never

/** Entries whose next segment is one parameter alone. */
type ParamEntries<E extends AnyEntry> = E extends { segs: readonly [infer H extends string, ...string[]] }
  ? [LoneName<H>] extends [never]
    ? never
    : E
  : never

/**
 * The call that supplies the next path parameter.
 *
 * `Pick` off the route's own params rather than a rebuilt object, so the value keeps the type *and* the optionality
 * the route's schema gave it: `:id` under an integer schema is a `number`, and `:id?` stays optional.
 *
 * Only a segment that is one parameter alone is offered. The proxy sends the value as the whole segment, and never
 * sees the route's path, so `:lat-:lng`, `:name.json` and what follows them are reached through `$request`.
 */
type ParamChild<E extends AnyEntry> = [ParamEntries<E>] extends [never]
  ? unknown
  : (params: ParamArg<ParamEntries<E>>) => Node<AdvanceAny<ParamEntries<E>>>

type ParamArg<E extends AnyEntry> = E extends {
  segs: readonly [infer H extends string, ...string[]]
  route: infer R extends RouteContract
}
  ? Pick<R['params'], Extract<LoneName<H>, keyof R['params']>>
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
 * There for what the proxy cannot serve — a path segment named after a verb or `then`, or `$request` at the root, a
 * method it has no verb for, and a path decided at run time — and deliberately for nothing else.
 */
export interface RawCall<R extends RouteContract> {
  $request<M extends R['method'], P extends Extract<R, { method: M }>['path']>(
    method: M,
    path: P,
    ...args: RawArgs<Extract<R, { method: M; path: P }>>
  ): Promise<BrewResponseOf<Extract<R, { method: M; path: P }>>>
}

type RawArgs<R extends RouteContract> =
  Partial<RawInit<R>> extends RawInit<R> ? [init?: RawInit<R>] : [init: RawInit<R>]

// A path whose parameters may all be left out may be addressed with no params at all. Asked of the empty object
// rather than of `Partial`, so the parameters of an optional segment stay together: all of them, or none.
type RawInit<R extends RouteContract> = CallInit<R> &
  ([keyof R['params']] extends [never]
    ? { params?: undefined }
    : Record<never, never> extends R['params']
      ? { params?: R['params'] }
      : { params: R['params'] })

/** The client: the route tree, plus the escape hatch and the file helpers, which keep their names at the root. */
export type BrewClient<T> = Node<EntriesOf<Routes<T>>, '$request' | keyof FileHelpers> &
  RawCall<Routes<T>> &
  FileHelpers
