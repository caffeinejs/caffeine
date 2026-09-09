import { describe, expect, it } from 'vitest'

import { ConfigEngine } from '../engine.js'
import { materialize } from '../materializer.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { ConfigPriority, ConfigSources } from '../sources.js'
import type { ConfigProvider, ResolutionContext } from '../types.js'

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
  it('lets a higher band win regardless of registration order', async () => {
    const sources = new ConfigSources()
      .add(provider('env', 'from-env'), ConfigPriority.ENV)
      .add(provider('code', 'from-code'), ConfigPriority.CODE)

    // Registered last and still loses: a value set in code is a default, not an override.
    expect(await hostFrom(sources)).toBe('from-env')
  })

  it('lets a higher band win when it is registered last, too', async () => {
    const sources = new ConfigSources()
      .add(provider('code', 'from-code'), ConfigPriority.CODE)
      .add(provider('args', 'from-args'), ConfigPriority.ARGS)

    expect(await hostFrom(sources)).toBe('from-args')
  })

  it('breaks ties within a band by registration order', async () => {
    const sources = new ConfigSources().add(provider('first', 'first')).add(provider('second', 'second'))

    expect(await hostFrom(sources)).toBe('first')
  })

  it('puts an unqualified source in the USER band, above code and below the environment', async () => {
    const sources = new ConfigSources()
      .add(provider('code', 'from-code'), ConfigPriority.CODE)
      .add(provider('user', 'from-user'))

    expect(await hostFrom(sources)).toBe('from-user')

    const outranked = new ConfigSources()
      .add(provider('user', 'from-user'))
      .add(provider('env', 'from-env'), ConfigPriority.ENV)

    expect(await hostFrom(outranked)).toBe('from-env')
  })

  it('accepts an explicit priority so a source can be placed above the environment', async () => {
    const sources = new ConfigSources()
      .add(provider('env', 'from-env'), ConfigPriority.ENV)
      // The supported way to make something beat the environment: register it higher, not by a special case.
      .add(provider('override', 'from-override'), ConfigPriority.ARGS + 100)

    expect(await hostFrom(sources)).toBe('from-override')
  })

  it('drops a removed source from the next resolve', async () => {
    const sources = new ConfigSources()
      .add(provider('env', 'from-env'), ConfigPriority.ENV)
      .add(provider('code', 'from-code'), ConfigPriority.CODE)

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
    expect(sources.resolved().map(p => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('sees a source added after a first resolve on the next one', async () => {
    const sources = new ConfigSources().add(provider('code', 'from-code'), ConfigPriority.CODE)
    expect(await hostFrom(sources)).toBe('from-code')

    sources.add(provider('env', 'from-env'), ConfigPriority.ENV)
    expect(await hostFrom(sources)).toBe('from-env')
  })

  it('holds providers in order from ConfigSources.of', () => {
    const sources = ConfigSources.of(provider('a', 'a'), provider('b', 'b'))
    expect(sources.resolved().map(p => p.id)).toEqual(['a', 'b'])
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
 * independently — and a higher-priority source overriding a three-element list with a two-element one would
 * leave the third element behind, from the source it was supposed to have overridden. Shortening a list from
 * the environment would be impossible.
 */
describe('array merging across bands', () => {
  it('replaces the whole list from the highest band that mentions it', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b', 'c'] }), ConfigPriority.CODE)
      .add(tree('env', { tags: ['x', 'y'] }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).tags).toEqual(['x', 'y'])
  })

  it('lets a higher band clear a list entirely', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b', 'c'] }), ConfigPriority.CODE)
      .add(tree('env', { tags: [] }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).tags).toEqual([])
  })

  it('uses a lower band in full when no higher band mentions the path', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b', 'c'] }), ConfigPriority.CODE)
      .add(tree('env', { other: 1 }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).tags).toEqual(['a', 'b', 'c'])
  })

  it('claims a nested array through its outermost prefix', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { items: [{ hosts: ['a', 'b'] }, { hosts: ['c'] }] }), ConfigPriority.CODE)
      .add(tree('env', { items: [{ hosts: ['z'] }] }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).items).toEqual([{ hosts: ['z'] }])
  })

  it('leaves scalars alone', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a'], port: 3000, host: 'h' }), ConfigPriority.CODE)
      .add(tree('env', { tags: ['x'], port: 8080 }), ConfigPriority.ENV)

    const materialized = await materializedFrom(sources)
    expect(materialized).toEqual({ tags: ['x'], port: 8080, host: 'h' })
  })

  it('accepts a single-element list from a higher band', async () => {
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b'] }), ConfigPriority.CODE)
      .add(tree('env', { tags: ['only'] }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).tags).toEqual(['only'])
  })

  it('lets a higher band replace a whole list with one scalar key', async () => {
    // What a text source produces: `TAGS=x,y` is a single key at `tags`, not indexed keys. It has to beat the
    // lower band's `tags.0/1/2` — otherwise both survive the merge, the materializer lets the indexed children
    // overwrite the scalar, and the value the operator set disappears without a word. Splitting it into a list
    // is validation's job, not the merge's.
    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b', 'c'] }), ConfigPriority.CODE)
      .add(tree('env', { tags: 'x,y' }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).tags).toBe('x,y')
  })

  it('still merges siblings from different bands into one object', async () => {
    // Owning a path must not mean owning its parent: claiming `server.port` leaves `server.host` alone.
    const sources = new ConfigSources()
      .add(tree('code', { server: { host: 'code-host', port: 1 } }), ConfigPriority.CODE)
      .add(tree('env', { server: { port: 8080 } }), ConfigPriority.ENV)

    expect((await materializedFrom(sources)).server).toEqual({ host: 'code-host', port: 8080 })
  })

  it('rejects a higher band that supplies only some indices', async () => {
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

    const sources = new ConfigSources()
      .add(tree('code', { tags: ['a', 'b'] }), ConfigPriority.CODE)
      .add(patch, ConfigPriority.ENV)

    await expect(materializedFrom(sources)).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_ARRAY_INDICES',
    })
    await expect(materializedFrom(sources)).rejects.toThrow(/tags/)
  })
})
