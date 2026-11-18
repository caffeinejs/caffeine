import { validateSchema } from '@caffeinejs/application/schema'
import { KiB } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { MultipartConfigSchema } from './multipart.js'

describe('MultipartConfigSchema', () => {
  it('decodes byte sizes and counts without filling in route-dependent defaults', () => {
    expect(
      validateSchema(
        MultipartConfigSchema,
        { maxPartSize: '8kb', maxParts: 12, maxFiles: '0', maxDepth: '16' },
        { decode: true },
      ),
    ).toEqual({ ok: true, value: { maxPartSize: 8 * KiB, maxParts: 12, maxFiles: 0, maxDepth: 16 } })
  })

  it.each([
    { maxParts: 1.5 },
    { maxHeaders: '1.5' },
    { maxFiles: -1 },
    { maxDepth: '17' },
    { maxParts: '9007199254740992' },
  ])('rejects an invalid count without rounding it: %o', limits => {
    expect(validateSchema(MultipartConfigSchema, limits, { decode: true }).ok).toBe(false)
  })

  it.each([{ maxPartSizes: '8kb' }, { maxPartSize: '0kb' }])('rejects invalid options during decoding: %o', limits => {
    expect(validateSchema(MultipartConfigSchema, limits, { decode: true }).ok).toBe(false)
  })

  it.each([
    { maxFiles: true },
    { maxFiles: false },
    { maxFiles: 'true' },
    { maxFiles: 'false' },
    { maxFiles: [1] },
    { maxPartSize: ['1kb'] },
  ])('rejects non-scalar sizes and non-numeric counts as supplied: %o', limits => {
    expect(validateSchema(MultipartConfigSchema, limits, { decode: true }).ok).toBe(false)
  })
})
