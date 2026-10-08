import type { FetchyRequest } from '../request.js'

// A body sent again, by a retry or an authentication follow-up, has to survive being sent. Anything not listed is taken
// for a stream or an iterator, which the first send may have read.
export function isReplayable(body: FetchyRequest['body']): boolean {
  return (
    body === null ||
    body === undefined ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  )
}
