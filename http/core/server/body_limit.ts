import { MiB, type ByteSize } from '@caffeinejs/std/bytes'

/** The largest body a route reads unless the server or the route says otherwise. */
export const DEFAULT_BODY_LIMIT: ByteSize = 1 * MiB

/** Whether `value` is a body limit: a whole number of bytes above 0. */
export function isBodyLimit(value: unknown): value is ByteSize {
  return Number.isSafeInteger(value) && (value as number) > 0
}
