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
  delay: number
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
  delay: 500,
}
