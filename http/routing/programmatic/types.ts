import type { AnySchema, InferSchema } from '@caffeinejs/std'

import type { AdapterTypes, AnyAdapterTypes } from '../../adapter_types.js'
import type { Context, InferBody, InferHeaders, InferParams, InferQuery } from '../../context.js'
import type { RouteValidationSchema } from '../../route.js'

/** Flattens an intersection so editors show one object rather than a chain of `&`. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * The path parameters a route path declares, as `{ id: string }`.
 *
 * Reads the path the way the router matches it: `:name` is a parameter, `:name?` an optional one, a trailing
 * `(...)` on a parameter is a matching constraint rather than part of the name, and `*` is the wildcard. A path
 * that is not a literal type — one built at runtime — yields the open `Record<string, string>`.
 */
export type PathParams<P extends string> = string extends P ? Record<string, string> : ParamsOfPath<P>

type ParamsOfPath<P extends string> = P extends `${string}:${infer Tail}`
  ? Tail extends `${infer Segment}/${infer Rest}`
    ? ParamEntry<Segment> & ParamsOfPath<`/${Rest}`>
    : ParamEntry<Tail>
  : P extends `${string}*${string}`
    ? { '*': string }
    : Record<never, never>

type ParamEntry<Segment extends string> = Segment extends `${infer Name}?`
  ? { [K in ParamName<Name>]?: string }
  : { [K in ParamName<Segment>]: string }

type ParamName<Segment extends string> = Segment extends `${infer Name}(${string}` ? Name : Segment

/**
 * The type of `ctx.req.param()`: what the `params` schema declares when the route has one, and what the path
 * itself says when it does not.
 */
export type ParamsOf<S extends RouteValidationSchema, P extends string> = S extends { params: AnySchema }
  ? InferParams<S>
  : Simplify<PathParams<P>>

/**
 * The context a programmatic handler receives, typed by the route's schema and path.
 *
 * The same object a decorated handler gets from `$p.context()`, with the request slots narrowed to what this route
 * declared. `T` is the adapter the router is bound to; a router bound to none types it as a plain `Context` would.
 */
export type RouteContext<
  S extends RouteValidationSchema,
  P extends string,
  V,
  C,
  T extends AdapterTypes = never,
> = Context<V, C, ContextTypesOf<T>, ParamsOf<S, P>, InferQuery<S>, InferHeaders<S>, InferBody<S>>

/** The adapter types a context is typed with: the router's own, or any registered adapter's when it has none. */
type ContextTypesOf<T extends AdapterTypes> = [T] extends [never] ? AnyAdapterTypes : T

/**
 * What a route's handler is called with: the context, then the dependencies the route and its enclosing groups
 * injected — `undefined` when none did.
 *
 * The return value is whatever a decorated handler may return: a body to serialize, a `Responder`, a stream, or
 * nothing at all when the handler answered through the context. It is a type parameter so that a route can carry
 * what its handler answers with — see {@link DeclaredRoute}.
 */
export type RouteHandler<
  S extends RouteValidationSchema,
  P extends string,
  V,
  C,
  D,
  O = unknown,
  T extends AdapterTypes = never,
> = (ctx: RouteContext<S, P, V, C, T>, deps: D) => O

/**
 * The dependencies visible to a route: what its groups injected, with anything the route injected under the same
 * name taking over.
 */
export type MergeDeps<OUTER, INNER> = [OUTER] extends [undefined]
  ? INNER
  : [INNER] extends [undefined]
    ? OUTER
    : Simplify<Omit<OUTER, keyof INNER> & INNER>

/** Concatenates a group path with a route path, keeping both literal so parameters stay inferable. */
export type JoinPath<A extends string, B extends string> = A extends '' ? B : B extends '' | '/' ? A : `${A}${B}`

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
 */
export type DeclaredRoute<M extends string, P extends string, S extends RouteValidationSchema, O> = RouteDef<
  M,
  P,
  ParamsOf<S, P>,
  InferQuery<S>,
  InferHeaders<S>,
  InferBody<S>,
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
  ? InferSchema<S>
  : R extends { 201: infer S extends AnySchema }
    ? InferSchema<S>
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
  ? { [K in Extract<keyof R, number> as K]: R[K] extends AnySchema ? InferSchema<R[K]> : never }
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
 * The adapter a `Router` is bound to, read back the same way {@link RoutesOf} reads routes: `never` for a router
 * bound to none.
 */
export type AdapterOf<T> = T extends { readonly __adapter?: infer A } ? Extract<NonNullable<A>, AdapterTypes> : never

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
