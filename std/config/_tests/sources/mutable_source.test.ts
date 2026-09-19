import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../../load.js'
import { passthroughConfigSchema } from '../../schema.js'
import { InlineConfigSource } from '../../sources/inline_source.js'
import { MutableConfigSource } from '../../sources/mutable_source.js'
import { WATCH_DEBOUNCE_MS } from '../../triggers.js'
import type { ConfigSource } from '../../types.js'

function data(source: MutableConfigSource): unknown {
  return source.load()[0].data
}

function definition(sources: ConfigSource[]) {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MutableConfigSource', () => {
  it('treats a dotted path and a split one as the same path', () => {
    expect(data(new MutableConfigSource().set('server.port', 3000))).toEqual({ server: { port: 3000 } })
    expect(data(new MutableConfigSource().set(['server', 'port'], 3000))).toEqual({ server: { port: 3000 } })
  })

  it('keeps a key holding a dot as one key in the array form', () => {
    expect(data(new MutableConfigSource().set(['logging', 'com.acme'], 'debug'))).toEqual({
      logging: { 'com.acme': 'debug' },
    })
  })

  it('holds an array as one value, an empty one included', () => {
    expect(data(new MutableConfigSource().set('signals', ['SIGTERM', 'SIGINT']))).toEqual({
      signals: ['SIGTERM', 'SIGINT'],
    })
    expect(data(new MutableConfigSource().set('signals', []))).toEqual({ signals: [] })
  })

  it('replaces what it held at a path on a second set', () => {
    const source = new MutableConfigSource()
      .set('server', { port: 3000, host: '0.0.0.0' })
      .set('server', { port: 8080 })

    expect(data(source)).toEqual({ server: { port: 8080 } })
  })

  it('replaces a leaf with an object when a deeper path is set', () => {
    expect(data(new MutableConfigSource().set('a', 1).set('a.b', 2))).toEqual({ a: { b: 2 } })
  })

  it('merges from the root: objects key by key, anything else replaced', () => {
    const source = new MutableConfigSource().set('server.port', 3000).set('tags', ['a', 'b'])
    source.merge({ server: { host: '127.0.0.1' }, tags: ['c'] })

    expect(data(source)).toEqual({ server: { port: 3000, host: '127.0.0.1' }, tags: ['c'] })
  })

  it('unsets a leaf, a branch, and nothing that merely shares a prefix', () => {
    const source = new MutableConfigSource()
      .set('server.port', 3000)
      .set('serverless.port', 1)
      .set('health.verbose', true)

    source.unset('server')
    expect(data(source)).toEqual({ serverless: { port: 1 }, health: { verbose: true } })

    source.unset('health.verbose').unset('serverless')
    expect(source.empty).toBe(true)
  })

  it('discards everything on replace', () => {
    const source = new MutableConfigSource().set('server.port', 3000)
    source.replace({ health: { verbose: true } })

    expect(data(source)).toEqual({ health: { verbose: true } })
  })

  it('hands each load its own copy, so a later write cannot change one already handed out', () => {
    const source = new MutableConfigSource().set('server.port', 3000)
    const first = data(source)

    source.set('server.port', 8080)

    expect(first).toEqual({ server: { port: 3000 } })
    expect(data(source)).toEqual({ server: { port: 8080 } })
  })

  it('keeps no reference to a value it was handed', () => {
    const value = { port: 1 }
    const source = new MutableConfigSource().set('server', value)

    value.port = 2

    expect(data(source)).toEqual({ server: { port: 1 } })
  })

  it('tells whoever watches it about every write, until stopped', () => {
    const source = new MutableConfigSource()
    const changed = vi.fn()
    const stop = source.watch(changed)

    source.set('a', 1).merge({ b: 2 }).unset('a').replace({})
    stop()
    source.set('a', 1)

    expect(changed).toHaveBeenCalledTimes(4)
  })

  // A write reaches readers on its own: no refresh call, no reload call.
  it('reaches the store by itself, and only this source is loaded again', async () => {
    vi.useFakeTimers()
    let inlineLoads = 0
    const inline = new InlineConfigSource({ server: { host: 'h', port: 1 } })
    const counting: ConfigSource = {
      name: inline.name,
      load: () => {
        inlineLoads++
        return inline.load()
      },
    }
    const mutable = new MutableConfigSource('overrides')
    const store = await loadConfig(definition([counting, mutable]))
    const server = (store.live as { server: { port: number; host: string } }).server

    mutable.set('server.port', 9)
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS)

    expect(server.port).toBe(9)
    expect(server.host).toBe('h')
    expect(inlineLoads).toBe(1)
    await store.close()
  })

  it('is live', () => {
    expect(new MutableConfigSource().live).toBe(true)
  })
})

describe('InlineConfigSource', () => {
  it('contributes its object as one layer, named after the source', () => {
    expect(new InlineConfigSource({ a: 1 }).load()).toEqual([{ name: 'inline', data: { a: 1 } }])
    expect(new InlineConfigSource({ a: 1 }, 'fixtures').load()[0].name).toBe('fixtures')
  })

  it('is static', () => {
    const source: ConfigSource = new InlineConfigSource({})

    expect(source.live).toBeUndefined()
    expect(source.watch).toBeUndefined()
  })
})
