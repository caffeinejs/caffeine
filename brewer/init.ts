import type { RouteContract } from './contract.js'
import type { BrewResponseOf } from './response.js'

/** Whether `T` is the open record `InferQuery`/`InferHeaders` fall back to when a route declares no schema. */
type IsOpenRecord<T> = string extends keyof T ? true : false

type IsUnknown<T> = [unknown] extends [T] ? ([T] extends [unknown] ? true : false) : false

/**
 * What a query may hold when the route declares no schema for one.
 *
 * The open record `InferQuery` falls back to says `string`, which is narrower than what actually goes over the
 * wire: the client renders numbers and booleans, repeats a key per array item, and drops `undefined` entirely.
 * A declared schema is used as declared — this is only the shape of "anything".
 */
export type OpenQuery = Record<
  string,
  string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>
>

/** What headers may hold when the route declares no schema for them. A name given `undefined` is left out. */
export type OpenHeaders = Record<string, string | undefined>

type Slot<Name extends string, T, Optional extends boolean> = Optional extends true
  ? { [K in Name]?: T }
  : { [K in Name]: T }

/**
 * What a call takes: the request slots the route declared, plus anything `RequestInit` accepts.
 *
 * A slot is required only when the route declares something required in it. `query` and `headers` fall back to an
 * open record when there is no schema, and `body` to `unknown`, so those are the shapes that read as "not
 * declared" — which also means a route whose querystring schema is genuinely an open record is treated as
 * declaring none. It errs toward optional, which is the harmless direction. `query` and `headers` may also be left
 * out when every field they declare is optional; a declared body may not, since the server checks a missing one
 * against its schema.
 *
 * Path parameters are absent by construction: the segment calls supplied them.
 */
export type CallInit<R extends RouteContract> = Omit<RequestInit, 'method' | 'body' | 'headers'> &
  Slot<'query', IsOpenRecord<R['query']> extends true ? OpenQuery : R['query'], MayOmit<R['query']>> &
  Slot<'headers', IsOpenRecord<R['headers']> extends true ? OpenHeaders : R['headers'], MayOmit<R['headers']>> &
  Slot<'body', R['body'], IsUnknown<R['body']>>

/** Whether a query or headers slot may be left out: nothing is declared for it, or nothing declared is required. */
type MayOmit<T> = IsOpenRecord<T> extends true ? true : AllOptional<T>

/** Whether every slot of an init is optional, and so whether the argument may be left out entirely. */
type AllOptional<T> = Partial<T> extends T ? true : false

/** The call one verb makes: the init argument disappears when the route needs nothing from it. */
export type VerbCall<R extends RouteContract> = (
  ...args: AllOptional<CallInit<R>> extends true ? [init?: CallInit<R>] : [init: CallInit<R>]
) => Promise<BrewResponseOf<R>>
