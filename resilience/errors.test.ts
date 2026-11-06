import { Second } from '@caffeinejs/std/duration'
import { describe, expect, it } from 'vitest'

import { ErrBulkheadFull } from './bulkhead/bulkhead.js'
import { ErrCallRefused, ErrInvalidOption, failureOf } from './errors.js'
import { ErrTimeLimitExceeded } from './timelimiter/timelimiter.js'

// A transport answers with what failureOf says: a wrong kind turns a "try later" into a "gave up", or the reverse.
describe('failureOf', () => {
  it('reads a refusal as unavailable, with how long to wait', () => {
    expect(failureOf(new ErrCallRefused('refused', 'ERR_CALL_NOT_PERMITTED', 2 * Second))).toEqual({
      kind: 'unavailable',
      code: 'ERR_CALL_NOT_PERMITTED',
      retryAfter: 2_000,
    })
    expect(failureOf(new ErrBulkheadFull('exports', 3, 0))).toEqual({
      kind: 'unavailable',
      code: 'ERR_BULKHEAD_FULL',
      retryAfter: undefined,
    })
  })

  it('reads a time limit as a timeout', () => {
    expect(failureOf(new ErrTimeLimitExceeded('inventory', 2 * Second))).toEqual({
      kind: 'timeout',
      code: 'ERR_TIME_LIMIT_EXCEEDED',
      retryAfter: undefined,
    })
  })

  // A bug or a misconfiguration is not the dependency being unavailable: the transport's own handlers answer it.
  it.each([
    ['an option error', new ErrInvalidOption('bad')],
    ['an application error', new Error('down')],
    ['a value that is not an error', 'down'],
  ])('leaves out %s', (_, error) => {
    expect(failureOf(error)).toBe(undefined)
  })
})
