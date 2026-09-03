import type { RouteContract } from './contract.js'
import type { BrewResponse } from './response.js'

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

type Slot<Name extends string, T, Optional extends boolean> = Optional extends true
  ? { [K in Name]?: T }
  : { [K in Name]: T }

/**
 * What a call takes: the request slots the route declared, plus anything `RequestInit` accepts.
 *
 * A slot is required only when the route actually declares one. `query` and `headers` fall back to an open record
 * when there is no schema, and `body` to `unknown`, so those are the shapes that read as "not declared" — which
 * also means a route whose querystring schema is genuinely an open record is treated as declaring none. It errs
 * toward optional, which is the harmless direction.
 *
 * Path parameters are absent by construction: the segment calls supplied them.
 */
export type CallInit<R extends RouteContract> = Omit<RequestInit, 'method' | 'body' | 'headers'> &
  Slot<'query', IsOpenRecord<R['query']> extends true ? OpenQuery : R['query'], IsOpenRecord<R['query']>> &
  Slot<'headers', R['headers'], IsOpenRecord<R['headers']>> &
  Slot<'body', R['body'], IsUnknown<R['body']>>

/** Whether every slot of an init is optional, and so whether the argument may be left out entirely. */
type AllOptional<T> = Partial<T> extends T ? true : false

/** The call one verb makes: the init argument disappears when the route needs nothing from it. */
export type VerbCall<R extends RouteContract> = (
  ...args: AllOptional<CallInit<R>> extends true ? [init?: CallInit<R>] : [init: CallInit<R>]
) => Promise<BrewResponse<R['output']>>
