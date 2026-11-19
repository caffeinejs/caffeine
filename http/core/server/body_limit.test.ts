import { MiB } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BODY_LIMIT, isBodyLimit } from './body_limit.js'

describe('body limits', () => {
  it('defaults to one mebibyte', () => {
    expect(DEFAULT_BODY_LIMIT).toBe(1 * MiB)
  })

  it('accepts the largest safe byte count', () => {
    expect(isBodyLimit(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('refuses a byte count beyond the safe integer range', () => {
    expect(isBodyLimit(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  })
})
