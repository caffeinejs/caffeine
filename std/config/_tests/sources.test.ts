import { describe, expect, it } from 'vitest'

import type { ConfigProvider, ResolutionContext } from '../config.js'
import { ConfigEngine } from '../engine.js'
import { materialize } from '../materializer.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { ConfigSources } from '../sources.js'

const ctx: ResolutionContext = { profiles: ['default'] }

function provider(id: string, value: string): ConfigProvider {
  const inline = new InlineConfigProvider({ db: { host: value } }, id)
  return { id, load: c => inline.load(c) }
}

async function hostFrom(sources: ConfigSources): Promise<unknown> {
  const snapshot = await new ConfigEngine({ sources }).resolve(ctx)
  return snapshot.values.get('db.host')?.value
}

describe('ConfigSources', () => {
  it('lets the most recently registered source win a conflicting key', async () => {
    const sources = new ConfigSources().add(provider('first', 'first')).add(provider('second', 'second'))

    expect(await hostFrom(sources)).toBe('second')
  })

  it('lets a source registered after the fact override one registered before it, whichever it is', async () => {
    const sources = new ConfigSources().add(provider('base', 'from-base'))
    sources.add(provider('override', 'from-override'))

    expect(await hostFrom(sources)).toBe('from-override')
  })

  it('drops a removed source from the next resolve', async () => {
    const sources = new ConfigSources().add(provider('code', 'from-code')).add(provider('env', 'from-env'))

    expect(await hostFrom(sources)).toBe('from-env')

    expect(sources.remove('env')).toBe(true)
    expect(sources.size).toBe(1)
    expect(await hostFrom(sources)).toBe('from-code')
  })

  it('reports nothing removed for an unknown id', () => {
    const sources = new ConfigSources().add(provider('env', 'x'))
    expect(sources.remove('nope')).toBe(false)
    expect(sources.size).toBe(1)
  })

  it('reuses the resolved order until the registry changes', () => {
    const sources = new ConfigSources().add(provider('a', 'a')).add(provider('b', 'b'))

    const first = sources.resolved()
    expect(sources.resolved()).toBe(first)

    sources.add(provider('c', 'c'))
    expect(sources.resolved()).not.toBe(first)
    // Most recently registered first.
    expect(sources.resolved().map(p => p.id)).toEqual(['c', 'b', 'a'])
  })

  it('sees a source added after a first resolve on the next one', async () => {
    const sources = new ConfigSources().add(provider('code', 'from-code'))
    expect(await hostFrom(sources)).toBe('from-code')

    sources.add(provider('env', 'from-env'))
    expect(await hostFrom(sources)).toBe('from-env')
  })

  it('holds providers from ConfigSources.of in argument order, last argument winning', () => {
    const sources = ConfigSources.of(provider('a', 'a'), provider('b', 'b'))
    expect(sources.resolved().map(p => p.id)).toEqual(['b', 'a'])
  })
})

/** A source over a literal tree, flattened the way every real provider flattens one. */
function tree(id: string, data: Record<string, unknown>): ConfigProvider {
  const inline = new InlineConfigProvider(data as never, id)
  return { id, load: c => inline.load(c) }
}

async function materializedFrom(sources: ConfigSources): Promise<Record<string, unknown>> {
  return materialize(await new ConfigEngine({ sources }).resolve(ctx))
}

/**
 * Arrays are replaced, never complemented.
 *
 * Every provider flattens `['a','b','c']` into `tags.0/1/2`, so a plain per-key merge resolves each index
 * independently — and a later-registered source overriding a three-element list with a two-element one would
 * leave the third element behind, from the source it was supposed to have overridden. Shortening a list from
 * the environment would be impossible.
 */
describe('array merging across sources', () => {
  it('replaces the whole list from the most recently registered source that mentions it', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b', 'c'] }))
      .add(tree('env', { tags: ['x', 'y'] }))

    expect((await materializedFrom(sources)).tags).toEqual(['x', 'y'])
  })

  it('lets a later source clear a list entirely', async () => {
    const sources = new ConfigSources().add(tree('code', { tags: ['a', 'b', 'c'] })).add(tree('env', { tags: [] }))

    expect((await materializedFrom(sources)).tags).toEqual([])
  })

  it('uses an earlier source in full when no later source mentions the path', async () => {
    const sources = new ConfigSources().add(tree('code', { tags: ['a', 'b', 'c'] })).add(tree('env', { other: 1 }))

    expect((await materializedFrom(sources)).tags).toEqual(['a', 'b', 'c'])
  })

  it('claims a nested array through its outermost prefix', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { items: [{ hosts: ['a', 'b'] }, { hosts: ['c'] }] }))
      .add(tree('env', { items: [{ hosts: ['z'] }] }))

    expect((await materializedFrom(sources)).items).toEqual([{ hosts: ['z'] }])
  })

  it('leaves scalars alone', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a'], port: 3000, host: 'h' }))
      .add(tree('env', { tags: ['x'], port: 8080 }))

    const materialized = await materializedFrom(sources)
    expect(materialized).toEqual({ tags: ['x'], port: 8080, host: 'h' })
  })

  it('accepts a single-element list from a later source', async () => {
    const sources = new ConfigSources().add(tree('code', { tags: ['a', 'b'] })).add(tree('env', { tags: ['only'] }))

    expect((await materializedFrom(sources)).tags).toEqual(['only'])
  })

  it('lets a later source replace a whole list with one scalar key', async () => {
    // What a text source produces: `TAGS=x,y` is a single key at `tags`, not indexed keys. It has to beat the
    // earlier source's `tags.0/1/2` — otherwise both survive the merge, the materializer lets the indexed
    // children overwrite the scalar, and the value the operator set disappears without a word. Splitting it
    // into a list is validation's job, not the merge's.
    const sources = new ConfigSources().add(tree('code', { tags: ['a', 'b', 'c'] })).add(tree('env', { tags: 'x,y' }))

    expect((await materializedFrom(sources)).tags).toBe('x,y')
  })

  it('still merges siblings from different sources into one object', async () => {
    // Owning a path must not mean owning its parent: claiming `server.port` leaves `server.host` alone.
    const sources = new ConfigSources()
      .add(tree('code', { server: { host: 'code-host', port: 1 } }))
      .add(tree('env', { server: { port: 8080 } }))

    expect((await materializedFrom(sources)).server).toEqual({ host: 'code-host', port: 8080 })
  })

  it('replaces an array whose parent segment holds a literal dot', async () => {
    // A parent named `a.b` is claimed as the escaped key `a\.b` (`claimsOf` via `joinPath`); the merge probe
    // (`hasPrefixIn`) has to re-encode ancestors the same way. If the two ever drift apart, the earlier
    // source's third element survives a list the later source replaced.
    const escapedKeys = (id: string, entries: Array<[string, unknown]>): ConfigProvider => ({
      id,
      load: () =>
        Promise.resolve([
          { name: id, entries: new Map(entries.map(([k, v]) => [k, { key: k, value: v as never, origin: id }])) },
        ]),
    })

    const sources = new ConfigSources()
      .add(
        escapedKeys('code', [
          ['a\\.b.0', 'a'],
          ['a\\.b.1', 'b'],
          ['a\\.b.2', 'c'],
        ]),
      )
      .add(
        escapedKeys('env', [
          ['a\\.b.0', 'x'],
          ['a\\.b.1', 'y'],
        ]),
      )

    expect((await materializedFrom(sources))['a.b']).toEqual(['x', 'y'])
  })

  it('rejects a later source that supplies only some indices', async () => {
    // `TAGS__1=z` produces exactly the keys "the whole list is ['z']" would, minus index 0. Replacing on that
    // basis yields a holed array that surfaces later as a baffling complaint about index 0, so say so here.
    const patch: ConfigProvider = {
      id: 'env',
      load: () =>
        Promise.resolve([
          {
            name: 'env',
            entries: new Map([['tags.1', { key: 'tags.1', value: 'z', origin: 'env:TAGS__1' }]]),
          },
        ]),
    }

    const sources = new ConfigSources().add(tree('code', { tags: ['a', 'b'] })).add(patch)

    await expect(materializedFrom(sources)).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_ARRAY_INDICES',
    })
    await expect(materializedFrom(sources)).rejects.toThrow(/tags/)
  })
})
