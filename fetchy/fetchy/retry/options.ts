import { type Duration, Millisecond } from '@caffeinejs/std/duration'

export interface RetryOptions {
  limit: number
  methods: string[]
  statusCodes: number[]
  /**
   * Codes of the transport failures to retry, matched against the error's `code`, or its `cause`'s:
   * `fetch` rejects with a `TypeError` whose `cause` carries the code, undici's own API with the
   * coded error itself.
   */
  errorCodes: string[]
  /** The minimum wait between attempts. The configured retry header can extend it. */
  delay: Duration
  /**
   * Response header carrying the server's retry wait, defaulting to `retry-after`.
   * Names are case-insensitive; values must be whole seconds or an HTTP date, including for custom headers.
   */
  retryAfterHeader: string
  /**
   * The largest server-requested wait from `retryAfterHeader` to accept. A larger value ends retries with
   * the current response, without consuming its body. Unset, only a wait longer than a timer can hold
   * (about 24.8 days) ends retries. This does not cap `delay` or the total time spent retrying.
   */
  maxRetryAfter?: Duration
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  limit: 3,
  methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'],
  statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
  errorCodes: [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ],
  delay: 500 * Millisecond,
  retryAfterHeader: 'retry-after',
}
