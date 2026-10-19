import type { FetchyRequest } from '../request.js'
import { isFormDataLike } from './form_data.js'

// A body sent again, by a retry or an authentication follow-up, has to survive being sent. Anything not listed is taken
// for a stream or an iterator, which the first send may have read. A FormData of any implementation is encoded again on
// each send.
export function isReplayable(body: FetchyRequest['body']): boolean {
  return (
    body === null ||
    body === undefined ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    (typeof body === 'object' && isFormDataLike(body))
  )
}
