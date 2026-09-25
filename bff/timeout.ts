import { DURATION_PATTERN, toMillis, type Duration } from '@caffeinejs/std/duration'

import type { Call } from './call.js'
import { ErrBFFInvalidTimeout, ErrBFFTimeout } from './errors.js'

const durationText = new RegExp(DURATION_PATTERN)

/**
 * Bounds one call. A number is already milliseconds; a duration string is converted with {@link toMillis}.
 *
 * The timer stays referenced. It is what settles a call that ignores the signal, and it is cleared when the
 * call settles, so it does not hold the process afterwards.
 *
 * @throws {@link ErrBFFInvalidTimeout} when `limit` is not a positive duration. A string `parseDuration` would
 * read as `0` is refused here, because a `0`ms timer would abort every call.
 */
export function timeout<T>(limit: Duration): (call: Call<T>) => Call<T> {
  const ms = deadlineMs(limit)

  return call => signal => deadline(call, signal, ms)
}

function deadlineMs(limit: Duration): number {
  if (typeof limit === 'number') {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ErrBFFInvalidTimeout(limit)
    }

    return limit
  }

  if (!durationText.test(limit)) {
    throw new ErrBFFInvalidTimeout(limit)
  }

  const ms = toMillis(limit)
  if (ms <= 0) {
    throw new ErrBFFInvalidTimeout(limit)
  }

  return ms
}

function deadline<T>(call: Call<T>, signal: AbortSignal, ms: number): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }

  const controller = new AbortController()
  const onParent = (): void => {
    controller.abort(signal.reason)
  }
  signal.addEventListener('abort', onParent, { once: true })

  const timer = setTimeout(() => {
    controller.abort(new ErrBFFTimeout(ms))
  }, ms)

  return new Promise((resolve, reject) => {
    let done = false

    const finish = (settle: () => void): void => {
      if (done) {
        return
      }

      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onParent)
      controller.signal.removeEventListener('abort', onAbort)
      settle()
    }

    function onAbort(): void {
      finish(() => reject(controller.signal.reason))
    }

    controller.signal.addEventListener('abort', onAbort)

    // A call that ignores the signal can reject after the deadline has already won. `done` drops that
    // rejection so it is not unobserved.
    Promise.resolve()
      .then(() => {
        if (!done) {
          return call(controller.signal)
        }

        return undefined
      })
      .then(
        value => {
          if (!done) {
            finish(() => resolve(value as T))
          }
        },
        (error: unknown) => {
          if (!done) {
            finish(() => reject(error))
          }
        },
      )
  })
}
