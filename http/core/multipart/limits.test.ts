import { Byte, KiB, MiB } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { ErrMultipart } from './error.js'
import {
  chargeMultipartLimit,
  MultipartBudget,
  resolveFrameLimits,
  resolveMultipartLimits,
  snapshotMultipartLimits,
} from './limits.js'

describe('multipart limits', () => {
  it('gives a finite message bounded defaults, with a per-part limit derived from its body limit', () => {
    expect(resolveMultipartLimits()).toEqual({
      maxPartSize: 1 * MiB,
      maxFieldSize: 64 * KiB,
      maxBufferedSize: 1 * MiB,
      maxHeaderSize: 16 * KiB,
      maxHeaders: 32,
      maxParts: 256,
      maxFiles: 16,
      maxDepth: 4,
    })
    expect(resolveMultipartLimits(3 * MiB).maxPartSize).toBe(3 * MiB)
    expect(() => resolveMultipartLimits(Infinity)).toThrow(TypeError)
  })

  it('combines independent overrides and keeps a stable snapshot', () => {
    const server = { maxParts: 9, maxFieldSize: 7 * KiB }
    const route = { maxFieldSize: 8 * KiB, maxFiles: 0, maxDepth: 0 }
    const limits = resolveMultipartLimits(2 * MiB, server, route)
    server.maxParts = 44
    route.maxFieldSize = 1 * Byte

    expect(limits).toMatchObject({ maxPartSize: 2 * MiB, maxParts: 9, maxFieldSize: 8 * KiB, maxFiles: 0, maxDepth: 0 })
    expect(Object.isFrozen(limits)).toBe(true)
  })

  it('inherits the server limit when the route supplies an undefined override', () => {
    const limits = resolveMultipartLimits(1 * MiB, { maxParts: 3 }, { maxParts: undefined, maxFiles: 0 })
    expect(limits).toMatchObject({ maxParts: 3, maxFiles: 0 })
  })

  it.each([
    null,
    [],
    5,
    new Date(),
    { maxFileSize: 10 },
    { maxHeaders: 0 },
    { maxParts: -1 },
    { maxFiles: -1 },
    { maxDepth: 17 },
    { maxDepth: 1.5 },
    { maxPartSize: 0 },
    { maxFieldSize: Infinity },
    { maxBufferedSize: NaN },
    { maxHeaderSize: '12kb' },
    { maxParts: Number.MAX_SAFE_INTEGER + 1 },
    JSON.parse('{"__proto__":{"maxFiles":25}}'),
    { [Symbol('maxFile')]: 1 },
  ])('refuses an invalid limits object %#', limits => {
    expect(() => snapshotMultipartLimits(limits)).toThrow(TypeError)
  })

  it('accepts a zero file budget, all sixteen nested levels and the maximum representable count', () => {
    expect(snapshotMultipartLimits({ maxFiles: 0, maxDepth: 16, maxParts: Number.MAX_SAFE_INTEGER })).toEqual({
      maxFiles: 0,
      maxDepth: 16,
      maxParts: Number.MAX_SAFE_INTEGER,
    })
  })

  it('applies only per-frame policy on an explicit live stream', () => {
    expect(resolveFrameLimits()).toEqual({ maxPartSize: 8 * MiB, maxHeaderSize: 16 * KiB, maxHeaders: 32 })
    expect(resolveFrameLimits({ maxPartSize: 12 * MiB }).maxPartSize).toBe(12 * MiB)
    const finite = { maxHeaders: 4, maxParts: 8 }
    expect(() => resolveFrameLimits(finite)).toThrow(TypeError)
  })
})

describe('finite multipart budgets', () => {
  it.each([-1, 0.5])('rejects an invalid wire charge of %s without changing the remaining allowance', bytes => {
    const tree = new MultipartBudget(4 * Byte, resolveMultipartLimits(4 * Byte))
    tree.chargeWire(3 * Byte)

    expect(() => tree.chargeWire(bytes)).toThrow(TypeError)
    tree.chargeWire(1 * Byte)
    expect(() => tree.chargeWire(1 * Byte)).toThrow(/"bodyLimit"/)
  })

  it('charges wire bytes once, counts parts across levels, and bounds each payload separately', () => {
    const cap = 8 * Byte
    const limits = resolveMultipartLimits(cap, { maxParts: 2, maxDepth: 1, maxPartSize: 20 * Byte })
    const tree = new MultipartBudget(cap, limits)
    tree.chargeWire(3 * Byte)
    tree.takePart()
    tree.enterChild(1)
    tree.takePart()
    tree.chargeWire(5 * Byte)

    expect(chargeMultipartLimit(0, 8, limits.maxPartSize, 'maxPartSize')).toBe(8)
    expect(() => tree.takePart()).toThrow(expect.objectContaining({ code: 'ERR_MULTIPART', reason: 'limit' }))
    expect(() => tree.chargeWire(1 * Byte)).toThrow(/"bodyLimit"/)
    expect(() => tree.enterChild(2)).toThrow(/"maxDepth"/)
  })

  it('applies root-only depth, zero files and aggregate collector size independently', () => {
    const limits = resolveMultipartLimits(1 * MiB, { maxFiles: 0, maxDepth: 0, maxBufferedSize: 5 * Byte })
    const tree = new MultipartBudget(1 * MiB, limits)
    tree.takePart()
    expect(() => tree.enterChild(1)).toThrow(/"maxDepth"/)
    expect(() => tree.takeFile()).toThrow(/"maxFiles"/)
    const first = tree.startCollector()
    const sibling = tree.startCollector()
    first(2 * Byte)
    sibling(5 * Byte)
    first(3 * Byte)
    expect(() => first(1 * Byte)).toThrow(ErrMultipart)
    expect(() => sibling(1 * Byte)).toThrow(ErrMultipart)
  })

  it('refuses an increment before a sum can lose integer precision', () => {
    const cap = Number.MAX_SAFE_INTEGER
    expect(chargeMultipartLimit(cap - 1, 1, cap, 'maxPartSize')).toBe(cap)
    expect(() => chargeMultipartLimit(cap, 1, cap, 'maxPartSize')).toThrow(ErrMultipart)
  })
})
