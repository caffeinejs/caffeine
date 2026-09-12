import { describe, expect, it } from 'vitest'

import { liveFold } from '../live_fold.js'

describe('liveFold', () => {
  it('folds on first read', () => {
    const folded = liveFold(
      () => ({ seconds: 5 }),
      raw => ({ ms: raw.seconds * 1000 }),
    )

    expect(folded.ms).toBe(5_000)
  })

  it('refolds when the settings behind it change', () => {
    let seconds = 5
    const folded = liveFold(
      () => ({ seconds }),
      raw => ({ ms: raw.seconds * 1000 }),
    )

    expect(folded.ms).toBe(5_000)

    seconds = 9
    expect(folded.ms).toBe(9_000)
  })

  // The reason this exists rather than a plain getter: folding can have a side effect — the shutdown policy
  // emits its budget warnings while folding — and a reader touching five properties must not produce five
  // copies of them.
  it('does not refold while the settings are unchanged, however many properties are read', () => {
    let folds = 0
    const folded = liveFold(
      () => ({ a: 1, b: 2 }),
      raw => {
        folds++
        return { a: raw.a, b: raw.b, sum: raw.a + raw.b }
      },
    )

    void [folded.a, folded.b, folded.sum, folded.a]

    expect(folds).toBe(1)
  })

  it('compares the settings by value, not by identity', () => {
    let folds = 0
    const folded = liveFold(
      // A fresh object every read, as a builder reading through a config node produces.
      () => ({ port: 3000 }),
      raw => {
        folds++
        return { port: raw.port }
      },
    )

    void [folded.port, folded.port, folded.port]

    expect(folds).toBe(1)
  })

  // Bound by value into the container, so it has to behave like the object it stands in for.
  it('enumerates, spreads and serializes as the folded object', () => {
    const folded = liveFold(
      () => ({ seconds: 5 }),
      raw => ({ ms: raw.seconds * 1000, label: 'drain' }),
    )

    expect(Object.keys(folded).sort()).toEqual(['label', 'ms'])
    expect({ ...folded }).toEqual({ ms: 5_000, label: 'drain' })
    expect(JSON.stringify(folded)).toBe(JSON.stringify({ ms: 5_000, label: 'drain' }))
    expect('ms' in folded).toBe(true)
    expect('nope' in folded).toBe(false)
  })

  // A dispatcher, a handler, a class — the half of a feature's options that never came from a tree.
  it('hands back a merged-in value with its identity intact', () => {
    const dispatcher = { warn: () => undefined }
    const folded = liveFold(
      () => ({ seconds: 5 }),
      raw => ({ ms: raw.seconds * 1000, dispatcher }),
    )

    expect(folded.dispatcher).toBe(dispatcher)
  })

  it('throws on assignment rather than writing onto the empty proxy target', () => {
    const folded = liveFold(
      () => ({ seconds: 5 }),
      raw => ({ ms: raw.seconds * 1000 }),
    )

    expect(() => {
      ;(folded as { ms: number }).ms = 1
    }).toThrow(/Cannot redefine property/)
  })
})
