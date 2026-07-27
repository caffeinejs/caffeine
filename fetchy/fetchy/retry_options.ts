export interface RetryOptions {
  limit: number
  methods: string[]
  statusCodes: number[]
  delay: number
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  limit: 3,
  methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'],
  statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
  delay: 500,
}
