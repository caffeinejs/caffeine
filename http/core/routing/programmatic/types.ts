import type { AnySchema, InferWire } from '@caffeinejs/application/schema'

import type { IContext } from '../../../context.js'
import type { InferBody, InferHeaders, InferParams, InferQuery } from '../../../request.js'
import type { RouteValidationSchema } from '../spec.js'

/** Flattens an intersection so editors show one object rather than a chain of `&`. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * The path parameters a route path declares, as `{ id: string }`.
 *
 * Reads the path the way the router matches it: `:name` is a parameter, a trailing `(...)` on a parameter is a
 * matching constraint rather than part of the name, and `*` is the wildcard. A segment may hold several parameters,
 * as `/near/:lat-:lng` and `/files/:name.:ext` do: a name ends at `(`, `-` or `.`, and text after it runs to the
 * next `:`. `::` is a literal colon. A trailing `?` makes a segment optional only when the segment starts with its
 * parameter and holds no constraint, as `:id?` and `:lat-:lng?` do; the parameters of such a segment come together
 * or not at all. Anywhere else the router reads the `?` as part of a name, as `item-:id?` binds `id?`, or as text.
 * A path that is not a literal type — one built at runtime — yields the open `Record<string, string>`.
 */
export type PathParams<P extends string> = string extends P ? Record<string, string> : ParamsOfPath<P>

type ParamsOfPath<P extends string> = P extends `${infer Lead}:${infer Tail}`
  ? Tail extends `:${infer After}`
    ? ParamsOfPath<After>
    : Tail extends `${infer Segment}/${infer Rest}`
      ? ParamEntry<Segment, Lead> & ParamsOfPath<`/${Rest}`>
      : ParamEntry<Tail, Lead>
  : P extends `${string}*${string}`
    ? { '*': string }
    : Record<never, never>

type ParamEntry<Segment extends string, Lead extends string> = [OptionalBody<Segment, Lead>] extends [never]
  ? { [K in SegmentNames<Segment>]: string }
  : OptionalEntry<SegmentNames<OptionalBody<Segment, Lead>>>

// What precedes the `?` of a segment the router reads as optional: one that starts with its parameter, after a `/`,
// and holds no constraint. `never` for any other segment.
type OptionalBody<Segment extends string, Lead extends string> = Lead extends `${string}/`
  ? Segment extends `${infer Body}?`
    ? Segment extends `${string}${'(' | ')'}${string}`
      ? never
      : Body
    : never
  : never

// The router drops an optional segment whole, so its parameters are all given or none is.
type OptionalEntry<Names extends string> =
  true extends IsUnion<Names> ? { [K in Names]: string } | { [K in Names]?: undefined } : { [K in Names]?: string }

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never

// The names in what follows a segment's first `:`. After each name, a constraint is skipped whole, and the text up
// to the next single `:` is literal.
type SegmentNames<S extends string> =
  | ParamName<S>
  | (S extends `${ParamName<S>}${infer Rest}` ? NextNames<AfterConstraint<Rest>> : never)

type ParamName<S extends string> = Before<Before<Before<S, '('>, '-'>, '.'>

type Before<S extends string, C extends string> = S extends `${infer Head}${C}${string}` ? Head : S

type NextNames<Text extends string> = Text extends `${string}:${infer Next}`
  ? Next extends `:${infer Escaped}`
    ? NextNames<Escaped>
    : SegmentNames<Next>
  : never

// What follows a constraint, its parentheses balanced as the router balances them: nested ones count, and a `\`
// escapes the character after it. Text that opens with no constraint is returned as it is.
type AfterConstraint<S extends string, Depth extends 0[] = []> = S extends `${infer C}${infer Rest}`
  ? Depth extends []
    ? C extends '('
      ? AfterConstraint<Rest, [0]>
      : S
    : C extends '\\'
      ? AfterConstraint<Rest extends `${string}${infer Skipped}` ? Skipped : '', Depth>
      : C extends '('
        ? AfterConstraint<Rest, [0, ...Depth]>
        : C extends ')'
          ? Depth extends [0]
            ? Rest
            : AfterConstraint<Rest, Depth extends [0, ...infer Outer extends 0[]] ? Outer : []>
          : AfterConstraint<Rest, Depth>
  : ''

/**
 * The type of `ctx.req.param()`: what the `params` schema declares when the route has one, and what the path
 * itself says when it does not.
 */
export type ParamsOf<S extends RouteValidationSchema, P extends string> = S extends { params: AnySchema }
  ? InferParams<S>
  : Simplify<PathParams<P>>

// As `ParamsOf`, for a client: what it sends, where a codec such as `$t.Duration()` is still text.
type WireParamsOf<S extends RouteValidationSchema, P extends string> = S extends { params: AnySchema }
  ? WireSlot<S, 'params', never>
  : Simplify<PathParams<P>>

// What a client sends in a request slot: the slot schema's wire side, or `Fallback` when the route declares none.
type WireSlot<S, Slot extends keyof RouteValidationSchema, Fallback> =
  S extends Record<Slot, infer Schema extends AnySchema> ? InferWire<Schema, 'input'> : Fallback

/**
 * The context a programmatic handler receives, typed by the route's schema and path.
 *
 * The same object a decorated handler gets from `$p.context()`, with the request slots narrowed to what this route
 * declared.
 */
export type RouteContext<S extends RouteValidationSchema, P extends string, V, C> = IContext<
  V,
  C,
  ParamsOf<S, P>,
  InferQuery<S>,
  InferHeaders<S>,
  InferBody<S>
>

/**
 * What a route's handler is called with: the context, then the dependencies the route and its enclosing groups
 * injected — `undefined` when none did.
 *
 * The return value is whatever a decorated handler may return: a body to serialize, bytes, a `Blob`, a stream, a
 * `Response`, a `Responder`, or nothing at all when the handler answered through the context. It is a type parameter
 * so that a route can carry what its handler answers with — see {@link DeclaredRoute}.
 */
export type RouteHandler<S extends RouteValidationSchema, P extends string, V, C, D, O = unknown> = (
  ctx: RouteContext<S, P, V, C>,
  deps: D,
) => O

/**
 * The dependencies visible to a route: what its groups injected, with anything the route injected under the same
 * name taking over.
 */
export type MergeDeps<OUTER, INNER> = [OUTER] extends [undefined]
  ? INNER
  : [INNER] extends [undefined]
    ? OUTER
    : Simplify<Omit<OUTER, keyof INNER> & INNER>

type Trimmed<P extends string> = P extends `${infer H}/` ? Trimmed<H> : P
type Rooted<P extends string> = P extends '' ? '' : P extends `/${string}` ? P : `/${P}`
/** A group path as the runtime keeps it: rooted, without a trailing "/". */
type GroupPath<P extends string> = Trimmed<Rooted<P>>
/**
 * Joins two group paths: a router's and a group or mount path under it. A path that is not a literal type joins to
 * `string`.
 */
export type JoinGroupPath<A extends string, B extends string> = string extends A | B
  ? string
  : `${GroupPath<A>}${GroupPath<B>}`
/**
 * Joins a group path and a route path as the server does, keeping both literal so parameters stay inferable: `/` is
 * the group's own path. A path that is not a literal type joins to `string`.
 */
export type JoinPath<A extends string, B extends string> = string extends A | B
  ? string
  : A extends unknown
    ? B extends unknown
      ? Rooted<B extends '' ? '/' : B> extends '/'
        ? GroupPath<A> extends ''
          ? '/'
          : GroupPath<A>
        : `${GroupPath<A>}${Rooted<B>}`
      : never
    : never

/**
 * One route, as a type: everything a client generated from the router needs to call it.
 *
 * Accumulated on the {@link Router} as routes are declared, so a router's type carries its whole surface. That is
 * the groundwork an end-to-end typed client is built from — it reads the union, and nothing at runtime has to
 * describe the API a second time.
 */
export interface RouteDef<
  M extends string = string,
  P extends string = string,
  Params = unknown,
  Query = unknown,
  Headers = unknown,
  Body = unknown,
  Output = unknown,
  Responses = unknown,
> {
  method: M
  path: P
  params: Params
  query: Query
  headers: Headers
  body: Body
  output: Output
  responses: Responses
}

/**
 * The descriptor a router accumulates for one route it declared: everything {@link RouteDef} holds, worked out
 * from the route's method, its full path, the schema it validates against and what its handler returns.
 *
 * It describes the route as a client sees it, on the wire: a codec such as `$t.Duration()` is the text sent and
 * received, not the value the handler works with.
 */
export type DeclaredRoute<M extends string, P extends string, S extends RouteValidationSchema, O> = RouteDef<
  M,
  P,
  WireParamsOf<S, P>,
  WireSlot<S, 'querystring', Record<string, string>>,
  WireSlot<S, 'headers', Record<string, string>>,
  WireSlot<S, 'body', unknown>,
  OutputOf<S, O>,
  ResponsesOf<S>
>

/**
 * What a route answers with.
 *
 * The declared response schema wins: it is the contract, and it is what the serializer actually enforces. Without
 * one the handler's own return type is used — unless the handler answered through the context, in which case there
 * is nothing to read and `unknown` is the honest answer.
 */
export type OutputOf<S extends RouteValidationSchema, O> = S extends { response: infer R }
  ? [SuccessBody<R>] extends [never]
    ? HandlerOutput<O>
    : SuccessBody<R>
  : HandlerOutput<O>

type SuccessBody<R> = R extends { 200: infer S extends AnySchema }
  ? InferWire<S, 'output'>
  : R extends { 201: infer S extends AnySchema }
    ? InferWire<S, 'output'>
    : never

type HandlerOutput<O> =
  Awaited<O> extends { readonly req: unknown; status: (code: number) => unknown } ? unknown : Awaited<O>

/**
 * What a route answers with, per status code, so a caller that checks the status knows the body that goes with it.
 *
 * Only codes written as numbers are read. A wildcard key — `'4xx'`, `'5xx'`, `'default'` — is left out on purpose:
 * it would have to be typed against `number`, which overlaps every literal code, and a union member whose status is
 * `number` stops `res.status === 200` narrowing to the 200 body. {@link OutputOf} still reads what it always read.
 */
export type ResponsesOf<S extends RouteValidationSchema> = S extends { response: infer R }
  ? { [K in Extract<keyof R, number> as K]: R[K] extends AnySchema ? InferWire<R[K], 'output'> : never }
  : unknown

/** Re-bases a set of route descriptors under a prefix, for a router mounted inside another. */
export type PrefixRoutePaths<R, Prefix extends string> =
  R extends RouteDef<
    infer M,
    infer P,
    infer Params,
    infer Query,
    infer Headers,
    infer Body,
    infer Output,
    infer Responses
  >
    ? RouteDef<M, JoinPath<Prefix, P>, Params, Query, Headers, Body, Output, Responses>
    : never

/**
 * The routes a `Router` or an application declares, as a union of {@link RouteDef}.
 *
 * ```ts
 * type API = RoutesOf<typeof app>
 * ```
 *
 * What carries the routes is the value `.handler()` returns, so a chain accumulates them all —
 * `router.get('/a').handler(f).get('/b').handler(g)`. Declaring routes as separate statements leaves one such
 * value per statement; `blend` unions them. The variable the routes were opened from carries none of them.
 */
export type RoutesOf<T> = T extends { readonly __routes?: infer R } ? NonNullable<R> : never

/**
 * What `ctx.state` carries under a `Router`, as the router declared it.
 *
 * Read back the same way {@link RoutesOf} reads routes, so that combining routers with `blend` keeps the
 * variables typed rather than resetting them to what an undeclared router has.
 */
export type VarsOf<T> = T extends { readonly __vars?: infer V } ? NonNullable<V> : never

/**
 * What `ctx.config` is typed as under a `Router`, as the router declared it with `.configType()`.
 *
 * Read back the same way {@link VarsOf} reads the variables, and for the same reason: `blend` must keep the
 * configuration typed rather than reset it to what an undeclared router has.
 */
export type ConfigOf<T> = T extends { readonly __config?: infer C } ? NonNullable<C> : never

/**
 * The dependencies a `Router` or an application declared with `.inject()`, keyed by the name handlers read them
 * under.
 *
 * Read back the same way {@link VarsOf} reads the variables, but intersected rather than unioned: a union of
 * routers declares the names of *all* of them, and a caller naming one has to reach every name. A target that
 * injected nothing reads as the empty object.
 *
 * Only group-level `.inject()` is carried. A route-level one types that route's handler and goes no further, so it
 * is not part of the router's type.
 */
export type DepsOf<T> = Flatten<UnionToIntersection<T extends { readonly __deps?: infer D } ? NonNullable<D> : never>>

// Folds the intersection into one object type. Not `Simplify`, whose trailing `& {}` is there to force the display
// eagerly and would survive into the result. `readonly` is dropped with it: it comes from the `const` spec
// `inject()` captured, and what this names is a bag of values to supply, not a read-only view of one.
type Flatten<T> = { -readonly [K in keyof T]: T[K] }

// Distributes the union into contravariant position so inference collapses it to an intersection — the standard
// trick, and the only way to turn "any of these routers" into "every name they declare".
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never
