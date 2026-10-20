import type { RouteContract } from './contract.js'
import type { FormDataOf } from './form.js'
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
 * against its schema. Declared headers take others beside them.
 *
 * A declared body that is a file, or holds one, is passed as a `FormData`: a multipart form is the only way a file
 * travels, and the platform encodes it. One built with `client.$formData(...)` has its fields checked against the
 * declared ones; a plain one is checked neither here nor by the server, which leaves an upload unvalidated. A
 * declared object is passed as itself, which goes as JSON, or, when every field is text, a number, a boolean or a
 * list of those, as a `URLSearchParams`, which goes as a classic form that every server reads and checks against
 * the same schema.
 *
 * A body the route does not declare may be a function that returns a `ReadableStream`, or a promise of one. It is
 * called when the request is sent, not when it is built, and again for each follow-up an authenticator sends, where a
 * stream passed as it is can be read only once: return a new stream on every call. A call answered without the server
 * opens nothing. Browsers send a stream only over HTTP/2, and Firefox and Safari not at all.
 *
 * Path parameters are absent by construction: the segment calls supplied them.
 */
export type CallInit<R extends RouteContract> = Omit<RequestInit, 'method' | 'body' | 'headers'> &
  Slot<'query', IsOpenRecord<R['query']> extends true ? OpenQuery : R['query'], MayOmit<R['query']>> &
  Slot<'headers', HeadersArg<R['headers']>, MayOmit<R['headers']>> &
  Slot<'body', BodyArg<R['body']>, IsUnknown<R['body']>>

/** Whether a query or headers slot may be left out: nothing is declared for it, or nothing declared is required. */
type MayOmit<T> = IsOpenRecord<T> extends true ? true : AllOptional<T>

/**
 * The headers a call sends: the ones the route declares, and others beside them, since a server keeps the headers no
 * schema names. The others take the declared value types too, or a numeric declared header would leave its own
 * value no type to have.
 */
type HeadersArg<H> = IsOpenRecord<H> extends true ? OpenHeaders : H & Record<string, H[keyof H] | string | undefined>

// What a call sends for a declared body: a file, or a body holding one, only as a multipart form; an object a form
// can carry as itself or as a classic form; anything else as declared. Not distributed: the server reads a union body
// as JSON, whatever its members hold.
type BodyArg<B> = [B] extends [object]
  ? true extends IsFile<B> | HoldsFile<B>
    ? FormDataOf<B>
    : false extends FitsForm<B>
      ? B
      : B | Form<B>
  : B

// A file or a list of files, perhaps left out, and nothing else: to the server, a union with another type, `null`
// included, is not one, and neither is a union of the two. A value typed `any` or `unknown` could hold anything, and
// is not taken for one either.
type IsFile<V> = unknown extends V
  ? false
  : [Exclude<V, undefined>] extends [never]
    ? false
    : [Exclude<V, undefined>] extends [Blob]
      ? true
      : [Exclude<V, undefined>] extends [readonly Blob[]]
        ? true
        : false

// Whether one of a body's own properties is a file: one level, as the server's `hasFileSchema` reads an upload, and
// never in a union, which it does not look inside even when every member holds the same file.
type HoldsFile<B> =
  true extends IsUnion<B> ? false : true extends { [K in keyof B]-?: IsFile<B[K]> }[keyof B] ? true : false

// Whether `T` is a union: some member of it is not the whole.
type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never

// Whether a classic form can carry the body: every field text, a number or a boolean, which the server coerces, or a
// list of those, sent as a repeated key. Asked of each member of a union.
type FitsForm<B> = B extends readonly unknown[]
  ? false
  : { [K in keyof B]-?: Exclude<B[K], undefined> extends FormField ? true : false }[keyof B]

type FormField = string | number | boolean | ReadonlyArray<string | number | boolean>

// A form beside the object. It names none of the object's keys, so TypeScript tells a literal object from it and
// still refuses a key the object does not declare, `size` and `sort` included. An open record has no keys to name.
type Form<B> =
  IsOpenRecord<B> extends true
    ? URLSearchParams
    : URLSearchParams & { [K in Exclude<keyof B, keyof URLSearchParams>]?: never }

/** Whether every slot of an init is optional, and so whether the argument may be left out entirely. */
type AllOptional<T> = Partial<T> extends T ? true : false

/** The call one verb makes: the init argument disappears when the route needs nothing from it. */
export type VerbCall<R extends RouteContract> = (
  ...args: AllOptional<CallInit<R>> extends true ? [init?: CallInit<R>] : [init: CallInit<R>]
) => Promise<BrewResponseOf<R>>
