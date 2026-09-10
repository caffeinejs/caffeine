import { describe, expect, it } from 'vitest'

import type { ConfigEntry, ConfigValue } from '../config.js'
import { mergeSources } from '../engine.js'
import { flattenObject } from '../flatten.js'
import { materialize } from '../materializer.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'

function keysOf(value: Record<string, ConfigValue>): string[] {
  const entries = new Map<string, ConfigEntry>()
  flattenObject(value, 'test', '', entries)

  return [...entries.keys()]
}

function roundTrip(value: Record<string, ConfigValue>): Record<string, unknown> {
  const entries = new Map<string, ConfigEntry>()
  flattenObject(value, 'test', '', entries)
  const sources = [{ name: 'test', entries }]

  return materialize({ sources, values: mergeSources(sources) })
}

describe('flattenObject', () => {
  // Flatten and materialize are the two halves of every resolve: a provider writes leaf keys, the engine merges
  // them, and the materializer rebuilds the tree. A value that does not survive that trip is a value the
  // application silently never receives, so the round trip is the contract — not an implementation detail.
  it.each([
    ['nested objects', { server: { host: 'localhost', port: 8080 } }],
    ['arrays of scalars', { tags: ['a', 'b', 'c'] }],
    [
      'arrays of objects',
      {
        items: [
          { id: 1, hosts: ['a'] },
          { id: 2, hosts: [] },
        ],
      },
    ],
    ['an empty array, which indexing alone would erase', { tags: [] }],
    ['null and false, which are values rather than absences', { a: null, b: false, c: 0 }],
  ])('round-trips %s', (_name, value) => {
    expect(roundTrip(value as Record<string, ConfigValue>)).toEqual(value)
  })

  // A dot in a key is a path separator, not part of the name. That is what lets a format with no nesting of its
  // own — INI, a properties file — describe a tree: `FileConfigProvider`'s parser hands back flat dotted keys
  // and the tree is rebuilt here. The two spellings are the same configuration, so this is deliberately not an
  // inverse: what comes back out is the nested form.
  it('reads a dotted key as a path, not as a literal name', () => {
    expect(keysOf({ 'db.host': 'x' })).toEqual(['db.host'])
    expect(roundTrip({ 'db.host': 'x' })).toEqual({ db: { host: 'x' } })
    expect(roundTrip({ 'db.host': 'x' })).toEqual(roundTrip({ db: { host: 'x' } }))
  })

  // The escape is how a caller means a dot literally, and the only way to reach a key an application declared
  // with one in its name. `set` takes pre-split parts, so it escapes them on the way in.
  it('keeps an escaped segment literal', async () => {
    const provider = new MutableConfigProvider('test')
    provider.set(['a.b', 'c'], { d: 1 })

    const [source] = await provider.load({ profiles: [] })

    expect([...source.entries.keys()]).toEqual(['a\\.b.c.d'])
    expect(materialize({ sources: [source], values: source.entries })).toEqual({ 'a.b': { c: { d: 1 } } })
  })
})
