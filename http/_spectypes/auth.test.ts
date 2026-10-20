import { validateSchema } from '@caffeinejs/application/schema'
import { Day, Hour, Minute, Second } from '@caffeinejs/std/duration'
import { describe, expect, it } from 'vitest'

import { AuthConfigSchema } from './auth.js'

describe('AuthConfigSchema', () => {
  // Every lifetime is a Duration, read from text. A bare number is refused rather than read as milliseconds: several of
  // these took one as seconds, and an hour written as 3600 would otherwise last 3.6 seconds.
  it('reads every lifetime from duration text', () => {
    const result = validateSchema(
      AuthConfigSchema,
      {
        schemes: {
          web: {
            expiresIn: '15m',
            maxAge: '8h',
            rememberMeMaxAge: '30d',
            rememberMeAbsoluteMaxAge: '90d',
            rememberMeRotationGrace: '30s',
            sessionCookieTtl: '1h',
            clockTolerance: '1m',
            httpTimeout: '5s',
            discoveryCacheTtl: '1h',
          },
        },
        refresh: { accessTtl: '15m', refreshTtl: '30d', absoluteTtl: '90d' },
      },
      { decode: true },
    )

    expect(result).toEqual({
      ok: true,
      value: {
        schemes: {
          web: {
            expiresIn: 15 * Minute,
            maxAge: 8 * Hour,
            rememberMeMaxAge: 30 * Day,
            rememberMeAbsoluteMaxAge: 90 * Day,
            rememberMeRotationGrace: 30 * Second,
            sessionCookieTtl: 1 * Hour,
            clockTolerance: 1 * Minute,
            httpTimeout: 5 * Second,
            discoveryCacheTtl: 1 * Hour,
          },
        },
        refresh: { accessTtl: 15 * Minute, refreshTtl: 30 * Day, absoluteTtl: 90 * Day },
      },
    })
  })

  it('refuses a lifetime written as a bare number', () => {
    expect(validateSchema(AuthConfigSchema, { refresh: { accessTtl: 900 } }).ok).toBe(false)
    expect(validateSchema(AuthConfigSchema, { schemes: { web: { maxAge: 3600 } } }).ok).toBe(false)
  })
})
