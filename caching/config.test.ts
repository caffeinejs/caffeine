import { newConfiguration } from '@caffeinejs/application'
import { ErrConfigValidation } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HTTPCachingConfigSchema } from './_spectypes/index.js'
import {
  HTTPCaching,
  cacheControl,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCacheStore,
  type HTTPCachingOptionsBuilder,
} from './http/index.js'
import { MemoryHTTPCacheStore } from './store/memory/index.js'

const appConfigSchema = $t.Object(
  { app: $t.Object({ caching: $t.Object(HTTPCachingConfigSchema.properties, { default: {} }) }, { default: {} }) },
  { default: {} },
)

// The slice as a source writes it, before validation decodes it.
interface CachingTree {
  statusHeader?: string
  storeTimeout?: string
  lockTimeout?: string
  varyByQuery?: string
  // A file source may give a number, which validation reads as text.
  maxEntrySize?: string | number
}

/** A store that answers nothing until the cache gives up on the call. */
class HungStore implements HTTPCacheStore {
  get(_key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  }

  async put(): Promise<void> {}

  async evictByTag(): Promise<void> {}
}

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const close of opened.splice(0)) {
    await close()
  }
})

/** Boots an application whose configuration tree carries the given caching slice. */
async function start(
  tree: CachingTree,
  options?: {
    env?: Record<string, string>
    store?: HTTPCacheStore
    body?: string
    handler?: () => string | Promise<string>
    fluent?: (b: HTTPCachingOptionsBuilder) => void
  },
) {
  const source = options?.env
    ? new EnvConfigSource({ env: options.env })
    : new InlineConfigSource({ app: { caching: tree } })
  const conf = newConfiguration(appConfigSchema).source(source).build().config
  const errors: unknown[] = []

  const router = newRouter('/cfg')
  router
    .get('/data')
    .extend(cacheControl({ ttl: 60 * Second }))
    .handler(options?.handler ?? (() => options?.body ?? 'payload'))

  const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })
    .with(
      HTTPCaching((b, { config }) => {
        b.store(options?.store ?? new MemoryHTTPCacheStore())
          .observer({ onError: event => errors.push(event.error) })
          .config(config.app.caching)
        options?.fluent?.(b)
      }),
    )
    .mount(router)
  opened.push(() => app.close())
  await app.bootstrap()

  return { app, errors }
}

describe('HTTP caching configuration', () => {
  // `$t.Duration()` decodes the text to milliseconds, the unit `HTTPCaching` reads. Read as seconds anywhere on the
  // way, a `50ms` store timeout would hold a request for 50 seconds.
  it('gives up on a store call after the storeTimeout the tree sets', async () => {
    const { app, errors } = await start({ storeTimeout: '50ms' }, { store: new HungStore() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = app.fetch('/cfg/data')
    await vi.advanceTimersByTimeAsync(60_000)
    const res = await pending

    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('did not settle within 50ms')
  })

  // The same for lockTimeout: read as seconds, a 50ms lock would keep a request waiting behind a slow leader for
  // 50 seconds instead of letting it run the handler itself.
  it('stops waiting on a slow leader after the lockTimeout the tree sets', async () => {
    let runs = 0
    let entered!: () => void
    const leading = new Promise<void>(resolve => (entered = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const { app } = await start(
      { lockTimeout: '50ms' },
      {
        handler: async () => {
          if (++runs === 1) {
            entered()
            await released
          }
          return 'payload'
        },
      },
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const leader = app.fetch('/cfg/data')
    await leading
    const follower = app.fetch('/cfg/data')
    await vi.advanceTimersByTimeAsync(50)

    expect((await follower).headers.get('x-cache')).toBe('MISS')
    expect(runs).toBe(2)

    release()
    await leader
  })

  it('names the status header after the tree', async () => {
    const { app } = await start({ statusHeader: 'X-From-Config' })

    const res = await app.fetch('/cfg/data')

    expect(res.headers.get('x-from-config')).toBe('MISS')
    expect(res.headers.get('x-cache')).toBeNull()
  })

  // A setting written in code is the last word: configuration retunes what code did not decide.
  it('lets a fluent method win over the same setting in the tree', async () => {
    const { app } = await start({ statusHeader: 'X-From-Config' }, { fluent: b => b.statusHeader('X-Fluent') })

    const res = await app.fetch('/cfg/data')

    expect(res.headers.get('x-fluent')).toBe('MISS')
    expect(res.headers.get('x-from-config')).toBeNull()
  })

  // A list arrives from the environment as text.
  it('keys entries on the query parameters the environment lists, and on no other', async () => {
    const { app } = await start({}, { env: { APP__CACHING__VARY_BY_QUERY: 'page,sort' } })

    expect((await app.fetch('/cfg/data?page=1&utm=a')).headers.get('x-cache')).toBe('MISS')
    expect((await app.fetch('/cfg/data?utm=b&page=1')).headers.get('x-cache')).toBe('HIT')
    expect((await app.fetch('/cfg/data?page=1&sort=name')).headers.get('x-cache')).toBe('MISS')
  })

  it('keeps a body larger than the maxEntrySize the tree sets out of the store', async () => {
    const { app } = await start({ maxEntrySize: '16b' }, { body: 'x'.repeat(20) })

    await app.fetch('/cfg/data')

    expect((await app.fetch('/cfg/data')).headers.get('x-cache')).toBe('MISS')
  })

  // Every unit is binary, so '1kb' is 1024 bytes, and a bare amount is bytes, given as text or as a number.
  it.each([
    ['1kb', 1024, 'HIT'],
    ['1kb', 1025, 'MISS'],
    ['1024', 1024, 'HIT'],
    [1024, 1024, 'HIT'],
    [1024, 1025, 'MISS'],
  ] as const)(
    'reads a maxEntrySize of %o from the tree, for a body of %d bytes',
    async (maxEntrySize, length, status) => {
      const { app } = await start({ maxEntrySize }, { body: 'x'.repeat(length) })

      await app.fetch('/cfg/data')

      expect((await app.fetch('/cfg/data')).headers.get('x-cache')).toBe(status)
    },
  )

  // A misspelling fails validation on the field, and so does a size too large to count exactly.
  it.each(['1KiB', '1.5kb', '-1kb', '8pb'])('refuses a maxEntrySize of %o from the tree', async maxEntrySize => {
    const failed = start({ maxEntrySize })

    await expect(failed).rejects.toThrow(ErrConfigValidation)
    await expect(failed).rejects.toThrow('app.caching.maxEntrySize')
  })

  // A bare number names no unit, so it is refused rather than guessed at.
  it.each(['storeTimeout', 'lockTimeout'])('refuses a %s the tree gives as a bare number', async option => {
    await expect(start({ [option]: '30000' })).rejects.toThrow(ErrConfigValidation)
    await expect(start({ [option]: '30000' })).rejects.toThrow(`app.caching.${option}`)
  })
})
