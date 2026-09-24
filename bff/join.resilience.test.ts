import { circuitBreaker, ErrCallNotPermitted, retry, runWith } from '@caffeinejs/resilience'
import { describe, expect, it } from 'vitest'

import { join, optional, required } from './index.js'

describe('join with resilience', () => {
  it('keeps the required value when an optional arm’s breaker is open', async () => {
    const breaker = circuitBreaker({ name: 'recs' })
    breaker.forceOpen()

    const screen = await join(new AbortController(), {
      user: required(async () => 'ada'),
      recs: optional(signal => runWith(() => 'titles', breaker, signal)),
    })

    expect(screen).toEqual({
      user: 'ada',
      recs: { ok: false, reason: 'unavailable' },
    })
  })

  it('rejects the join with the breaker refusal when a required arm is open', async () => {
    const breaker = circuitBreaker({ name: 'users' })
    breaker.forceOpen()

    await expect(
      join(new AbortController(), {
        user: required(signal => runWith(() => 'ada', breaker, signal)),
      }),
    ).rejects.toBeInstanceOf(ErrCallNotPermitted)
  })

  it('returns the value of a required arm that fails once and then succeeds under retry', async () => {
    let attempts = 0

    const screen = await join(new AbortController(), {
      user: required(signal =>
        runWith(
          () => {
            attempts += 1
            if (attempts === 1) {
              throw new Error('once')
            }

            return 'ada'
          },
          retry({ name: 'user', maxAttempts: 2, backoff: 0 }),
          signal,
        ),
      ),
    })

    expect(screen.user).toBe('ada')
    expect(attempts).toBe(2)
  })
})
