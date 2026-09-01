/**
 * The platform shapes this package names, spelled out rather than taken from a lib.
 *
 * `Headers`, `FormData`, `Blob` and the rest exist as globals in a browser and in Node, but `HeadersInit` and
 * `BodyInit` are aliases the DOM lib declares and Node's types do not. Naming them here is what lets the package
 * compile the same way under either.
 */
export type HeaderValues
  = | Headers
    | Record<string, string>
    | Array<[string, string]>

/** A body the platform already knows how to send, and that the client passes through untouched. */
export type RawBody
  = | string
    | FormData
    | URLSearchParams
    | Blob
    | ArrayBuffer
    | ArrayBufferView
    | ReadableStream
