import { describe, expect, expectTypeOf, it } from 'vitest'

import { type Arm, ErrBFFTimeout, join, map, optional, required, timeout } from './index.js'

describe('join', () => {
  it('returns required values bare and an optional value as an arm', async () => {
    const screen = await join(new AbortController(), {
      user: required(async () => ({ id: 'u1' })),
      orders: required(async () => [1]),
      recs: optional(async () => ['a']),
    })

    expect(screen).toEqual({
      user: { id: 'u1' },
      orders: [1],
      recs: { ok: true, value: ['a'] },
    })
    expectTypeOf(screen.user).toEqualTypeOf<{ id: string }>()
    expectTypeOf(screen.orders).toEqualTypeOf<number[]>()
    expectTypeOf(screen.recs).toEqualTypeOf<Arm<string[]>>()
  })

  it('resolves the screen when an optional call rejects, and keeps the error off the arm', async () => {
    const screen = await join(new AbortController(), {
      user: required(async () => 'ada'),
      recs: optional(async () => {
        throw new Error('recs down')
      }),
    })

    expect(screen).toEqual({
      user: 'ada',
      recs: { ok: false, reason: 'unavailable' },
    })
  })

  it('reports an optional deadline as timeout and rejects the join when a required deadline elapses', async () => {
    const hang = (signal: AbortSignal): Promise<string> =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })

    const screen = await join(new AbortController(), {
      user: required(async () => 'ada'),
      recs: optional(timeout(20)(hang)),
    })

    expect(screen).toEqual({
      user: 'ada',
      recs: { ok: false, reason: 'timeout' },
    })

    await expect(
      join(new AbortController(), {
        user: required(timeout(20)(hang)),
      }),
    ).rejects.toBeInstanceOf(ErrBFFTimeout)
  })

  it('rejects with the required call’s error and aborts a slower optional call', async () => {
    const error = new Error('users down')
    let aborted = false
    const slow = (signal: AbortSignal): Promise<string> =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true },
        )
      })

    await expect(
      join(new AbortController(), {
        user: required(async () => {
          throw error
        }),
        recs: optional(slow),
      }),
    ).rejects.toBe(error)
    expect(aborted).toBe(true)
  })

  it('does not call any arm when the signal is already aborted', async () => {
    const controller = new AbortController()
    const error = new Error('gone')
    controller.abort(error)
    let called = false

    await expect(
      join(controller, {
        user: required(async () => {
          called = true
          return 'ada'
        }),
      }),
    ).rejects.toBe(error)
    expect(called).toBe(false)
  })

  it('rejects when the signal aborts and does not return the optional arm', async () => {
    const controller = new AbortController()
    const error = new Error('gone')
    const pending = join(controller, {
      recs: optional(
        signal =>
          new Promise(resolve => {
            signal.addEventListener('abort', () => resolve('late'), { once: true })
          }),
      ),
    })
    controller.abort(error)

    await expect(pending).rejects.toBe(error)
  })

  it('stores the value map produced', async () => {
    const screen = await join(new AbortController(), {
      n: required(map((value: number) => value + 1)(async () => 1)),
    })

    expect(screen.n).toBe(2)
  })

  it('rejects the join when map throws on a required call', async () => {
    const error = new Error('bad shape')

    await expect(
      join(new AbortController(), {
        n: required(
          map(() => {
            throw error
          })(async () => 1),
        ),
      }),
    ).rejects.toBe(error)
  })
})
