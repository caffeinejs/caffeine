import { describe, expect, it } from 'vitest'

import type { Call } from './call.js'
import { ErrBFFInvalidTimeout, ErrBFFTimeout, timeout } from './index.js'

/** Settles only when `signal` aborts, and rejects with that reason. */
function untilAbort(): Call<string> {
  return signal =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
}

describe('timeout', () => {
  it('lets a fast call through for a millisecond number, the same duration string, and a longer deadline', async () => {
    const signal = new AbortController().signal
    const fast: Call<string> = async () => 'ok'

    await expect(timeout(50)(fast)(signal)).resolves.toBe('ok')
    await expect(timeout('50ms')(fast)(signal)).resolves.toBe('ok')
    await expect(timeout('1s')(fast)(signal)).resolves.toBe('ok')
  })

  it('aborts a call that outlives a millisecond deadline and the same duration string', async () => {
    const signal = new AbortController().signal

    await expect(timeout(50)(untilAbort())(signal)).rejects.toBeInstanceOf(ErrBFFTimeout)
    await expect(timeout('50ms')(untilAbort())(signal)).rejects.toBeInstanceOf(ErrBFFTimeout)
  })

  it('reads a number as milliseconds, so 1 aborts a call that would still be running after 1ms', async () => {
    const signal = new AbortController().signal
    // Resolves on its own after 200ms. A deadline of 1 second would let it through; 1ms does not.
    const slow: Call<string> = inner =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 200)
        inner.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(inner.reason)
          },
          { once: true },
        )
      })

    await expect(timeout(1)(slow)(signal)).rejects.toBeInstanceOf(ErrBFFTimeout)
  })

  it('refuses a deadline that is not a positive duration before the call runs', () => {
    let called = false
    const call: Call<string> = async () => {
      called = true
      return 'ok'
    }

    expect(() => timeout(0)(call)).toThrow(ErrBFFInvalidTimeout)
    expect(() => timeout('nope')(call)).toThrow(ErrBFFInvalidTimeout)
    expect(() => timeout('0s')(call)).toThrow(ErrBFFInvalidTimeout)
    expect(called).toBe(false)
  })
})
