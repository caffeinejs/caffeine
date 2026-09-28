/**
 * The response a transport resolves with: the part of {@link Response} fetchy reads.
 *
 * A native `Response` satisfies it, so the `fetch` transport returns one unchanged. Another transport may return its
 * own object, which is not an `instanceof Response`. Read or cancel its body, or the connection stays busy.
 */
export interface FetchyResponse {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | null
  readonly bodyUsed: boolean

  json(): Promise<unknown>

  text(): Promise<string>

  arrayBuffer(): Promise<ArrayBuffer>
}
