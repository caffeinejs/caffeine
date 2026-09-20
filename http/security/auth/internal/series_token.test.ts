import { describe, it, expect } from 'vitest'

import {
  SeriesTokenStore,
  formatToken,
  hashToken,
  newSeries,
  newSeriesToken,
  newToken,
  parseToken,
  readSeriesToken,
  rotateSeriesToken,
  tokenMatches,
  type SeriesTokenPolicy,
  type SeriesTokenRecord,
  type SeriesTokenRotation,
} from './series_token.js'

describe('series-token helpers', () => {
  it('generates distinct, high-entropy series and tokens', () => {
    const a = newSeries()
    const b = newSeries()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(20)
    expect(newToken()).not.toBe(newToken())
    expect(newToken().length).toBeGreaterThanOrEqual(40)
  })

  it('hashes a token deterministically and not to the token itself', () => {
    const token = newToken()
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(token)
  })

  it('tokenMatches is true for the right token, false otherwise', () => {
    const token = newToken()
    const stored = hashToken(token)
    expect(tokenMatches(token, stored)).toBe(true)
    expect(tokenMatches(newToken(), stored)).toBe(false)
    expect(tokenMatches(token, 'not-a-hash')).toBe(false)
  })

  it('round-trips series:token', () => {
    const s = newSeries()
    const t = newToken()
    expect(parseToken(formatToken(s, t))).toEqual({ series: s, token: t })
  })

  it('keeps the token intact even when it contains no separator ambiguity', () => {
    // base64url never contains ':' so the first colon is always the true separator.
    const parsed = parseToken('abc:def:ghi')
    expect(parsed).toEqual({ series: 'abc', token: 'def:ghi' })
  })

  it('rejects malformed input', () => {
    expect(parseToken('noseparator')).toBeNull()
    expect(parseToken(':leadingcolon')).toBeNull()
    expect(parseToken('trailingcolon:')).toBeNull()
    expect(parseToken('')).toBeNull()
  })
})

/** A store whose swap is atomic, as the contract asks: a single synchronous step cannot be interleaved. */
class MemoryStore extends SeriesTokenStore {
  readonly records = new Map<string, SeriesTokenRecord>()

  create(record: SeriesTokenRecord): void {
    this.records.set(record.series, { ...record })
  }

  // Asynchronous on purpose, so concurrent callers really do interleave between their read and their write.
  async findBySeries(series: string): Promise<SeriesTokenRecord | null> {
    await Promise.resolve()
    const record = this.records.get(series)
    return record === undefined ? null : { ...record }
  }

  rotate(series: string, expectedTokenHash: string, rotation: SeriesTokenRotation): boolean {
    const record = this.records.get(series)
    if (record === undefined || record.tokenHash !== expectedTokenHash) {
      return false
    }

    Object.assign(record, rotation)
    return true
  }

  remove(series: string): void {
    this.records.delete(series)
  }

  removeBySubject(subject: string): void {
    for (const [series, record] of this.records) {
      if (record.subject === subject) {
        this.records.delete(series)
      }
    }
  }
}

const NOW = 1_800_000_000
const strict: SeriesTokenPolicy = { idleSeconds: 3600, graceSeconds: 0 }
const lenient: SeriesTokenPolicy = { idleSeconds: 3600, graceSeconds: 60 }

function issued(policy: SeriesTokenPolicy, now = NOW) {
  const store = new MemoryStore()
  const { record, token } = newSeriesToken('alice', policy, now)
  store.create(record)

  return { store, record, token }
}

describe('readSeriesToken', () => {
  it('finds the token current right after it was issued', async () => {
    const { store, token, record } = issued(strict)

    expect(await readSeriesToken(store, token, strict, NOW)).toEqual({ status: 'current', record })
  })

  it.each([
    ['text that is no series:token', 'garbage', 'malformed'],
    ['a series the store never issued', `${newSeries()}:${newToken()}`, 'unknown'],
  ])('rejects %s', async (_label, presented, reason) => {
    const { store } = issued(strict)

    expect(await readSeriesToken(store, presented, strict, NOW)).toEqual({ status: 'rejected', reason })
  })

  it('rejects, and removes, a series that went unused for longer than its idle lifetime', async () => {
    const { store, token, record } = issued(strict)

    expect(await readSeriesToken(store, token, strict, NOW + 3600)).toEqual({ status: 'rejected', reason: 'expired' })
    expect(store.records.has(record.series)).toBe(false)
  })

  // A wrong token for a live series means someone holds a copy of a credential that was already spent.
  it('rejects a wrong token as a replay and removes the series, so the legitimate holder signs in again too', async () => {
    const { store, record } = issued(strict)

    const reading = await readSeriesToken(store, formatToken(record.series, newToken()), strict, NOW)

    expect(reading).toEqual({ status: 'rejected', reason: 'replayed' })
    expect(store.records.has(record.series)).toBe(false)
  })
})

describe('rotateSeriesToken', () => {
  it('swaps in a new token, keeps the old hash as the superseded one, and pushes the idle expiry back', async () => {
    const { store, token, record } = issued(strict)

    const rotated = await rotateSeriesToken(store, token, record, strict, NOW + 100)

    expect(rotated.status).toBe('rotated')
    const stored = store.records.get(record.series)!
    expect(stored.previousTokenHash).toBe(record.tokenHash)
    expect(stored.rotatedAt).toBe(NOW + 100)
    expect(stored.expiresAt).toBe(NOW + 100 + 3600)
    expect(stored.createdAt).toBe(NOW)

    // The new token is the current one, and the old one is spent.
    const next = (rotated as { token: string }).token
    expect((await readSeriesToken(store, next, strict, NOW + 100)).status).toBe('current')
    expect(await readSeriesToken(store, token, strict, NOW + 100)).toEqual({ status: 'rejected', reason: 'replayed' })
  })

  describe('an absolute lifetime', () => {
    const capped: SeriesTokenPolicy = { idleSeconds: 3600, absoluteSeconds: 5000, graceSeconds: 0 }

    // The idle expiry moves with every use, so by itself it lets a series that stays in use live forever.
    it('cuts the idle expiry short, however often the series is used', async () => {
      const { store, token, record } = issued(capped)

      await rotateSeriesToken(store, token, record, capped, NOW + 3000)

      expect(store.records.get(record.series)!.expiresAt).toBe(NOW + 5000)
    })

    it('ends the series when it is reached, used or not', async () => {
      const { store, token } = issued(capped)

      expect(await readSeriesToken(store, token, capped, NOW + 5000)).toEqual({ status: 'rejected', reason: 'expired' })
    })

    it('never outlives the absolute lifetime at issue either', () => {
      const short: SeriesTokenPolicy = { idleSeconds: 3600, absoluteSeconds: 60, graceSeconds: 0 }

      expect(newSeriesToken('alice', short, NOW).record.expiresAt).toBe(NOW + 60)
    })
  })

  describe('two requests presenting the same token at once', () => {
    // Read-then-write let both of them rotate: one token spent twice, and whichever cookie the browser kept last
    // decided whether the next request looked like a theft.
    it('lets exactly one rotate under strict single use, and treats the rest as a replay', async () => {
      const { store, token, record } = issued(strict)

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const reading = await readSeriesToken(store, token, strict, NOW)
          return reading.status === 'current' ? rotateSeriesToken(store, token, reading.record, strict, NOW) : reading
        }),
      )

      expect(outcomes.filter(outcome => outcome.status === 'rotated')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(19)
      // Spent twice is a replay, so the whole series is gone — the winner's new token with it.
      expect(store.records.has(record.series)).toBe(false)
    })

    it('lets exactly one rotate inside a grace window, and lets the rest through without a new token', async () => {
      const { store, token, record } = issued(lenient)

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const reading = await readSeriesToken(store, token, lenient, NOW)
          return reading.status === 'current' ? rotateSeriesToken(store, token, reading.record, lenient, NOW) : reading
        }),
      )

      expect(outcomes.filter(outcome => outcome.status === 'rotated')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.status === 'superseded')).toHaveLength(19)
      expect(store.records.has(record.series)).toBe(true)
    })
  })

  describe('a superseded token', () => {
    it('is good for a request that arrives inside the grace window, and is not rotated again', async () => {
      const { store, token, record } = issued(lenient)
      await rotateSeriesToken(store, token, record, lenient, NOW)
      const before = { ...store.records.get(record.series)! }

      expect((await readSeriesToken(store, token, lenient, NOW + 60)).status).toBe('superseded')
      expect(store.records.get(record.series)).toEqual(before)
    })

    it('is a replay once the window has passed', async () => {
      const { store, token, record } = issued(lenient)
      await rotateSeriesToken(store, token, record, lenient, NOW)

      expect(await readSeriesToken(store, token, lenient, NOW + 61)).toEqual({ status: 'rejected', reason: 'replayed' })
      expect(store.records.has(record.series)).toBe(false)
    })

    // `0` is an off switch, not a zero-width window: a replay landing in the same second must still be caught.
    it('is a replay at once when the grace is zero', async () => {
      const { store, token, record } = issued(strict)
      await rotateSeriesToken(store, token, record, strict, NOW)

      expect(await readSeriesToken(store, token, strict, NOW)).toEqual({ status: 'rejected', reason: 'replayed' })
    })

    it('is a replay when the store kept no record of the rotation', async () => {
      const { store, token, record } = issued(lenient)
      await rotateSeriesToken(store, token, record, lenient, NOW)
      delete store.records.get(record.series)!.previousTokenHash

      expect((await readSeriesToken(store, token, lenient, NOW + 1)).status).toBe('rejected')
    })
  })
})
