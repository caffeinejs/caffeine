import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import type { Encoding } from './manifest/manifest.js'
import { selectEncoding } from './negotiate.js'

const TOKENS = ['br', 'gzip', 'x-gzip', 'identity', '*', 'deflate', 'BR', 'Gzip'] as const

const entry = fc.record({
  token: fc.constantFrom(...TOKENS),
  q: fc.option(fc.constantFrom('0', '0.5', '0.500', '1', '1.0', '0.001', 'abc', '2'), { nil: undefined }),
})

// The rating a client gave each coding, read the way the RFC asks, written apart from the parser under test.
function ratingOf(entries: readonly { token: string; q: string | undefined }[], coding: string): number | undefined {
  const rated = new Map<string, number>()

  for (const { token, q } of entries) {
    const name = token.toLowerCase() === 'x-gzip' ? 'gzip' : token.toLowerCase()
    const valid = q === undefined || /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)

    if (!rated.has(name) && valid) {
      rated.set(name, q === undefined ? 1 : Number(q))
    }
  }

  return rated.get(coding) ?? rated.get('*')
}

const SIZES: Record<Encoding | 'identity', number> = { br: 1, gzip: 2, identity: 3 }

describe('selectEncoding (property)', () => {
  it.prop([fc.array(entry, { minLength: 1, maxLength: 8 }), fc.subarray<Encoding>(['br', 'gzip'])], { numRuns: 1000 })(
    'selects only what the client accepts, and among equal ratings the smallest',
    (entries, available) => {
      const header = entries.map(({ token, q }) => (q === undefined ? token : `${token};q=${q}`)).join(', ')
      const selected = selectEncoding(header, available)
      const candidates = [...available, 'identity' as const].map(coding => {
        const q = ratingOf(entries, coding)

        // Identity the header leaves unrated is acceptable, preferred least.
        return { coding, q: q ?? (coding === 'identity' ? Number.MIN_VALUE : 0) }
      })
      const best = Math.max(...candidates.map(({ q }) => q))

      if (best === 0) {
        expect(selected).toBe(undefined)
        return
      }

      const smallest = candidates
        .filter(({ q }) => q === best)
        .toSorted((a, b) => SIZES[a.coding] - SIZES[b.coding])[0]!.coding

      expect(selected).toBe(smallest)
    },
  )
})
