import { FetchyHeaders } from './headers.js'

/**
 * An outgoing request, shaped for both `fetch` and undici's dispatcher so neither transport converts it.
 *
 * It is mutable: an interceptor changes it in place or passes a {@link FetchyRequest.clone} to `proceed`.
 */
export class FetchyRequest {
  constructor(
    public method: string,
    /** Scheme, host and port, e.g. `https://api.test`. */
    public origin: string,
    /** Path and query string, e.g. `/v1/users/1?active=true`. */
    public path: string,
    public headers: FetchyHeaders = new FetchyHeaders(),
    public body: RequestInit['body'] = null,
    public signal?: AbortSignal,
  ) {}

  get url(): string {
    return this.origin + this.path
  }

  /**
   * Copies the request with its own headers. The body is shared, so a stream body can still be read only once.
   */
  clone(): FetchyRequest {
    return new FetchyRequest(
      this.method,
      this.origin,
      this.path,
      new FetchyHeaders(this.headers.record),
      this.body,
      this.signal,
    )
  }
}
