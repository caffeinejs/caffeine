import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaffeineIoC, Injectable, Profile, token } from '@caffeinejs/di'
import type { OnBootstrap, OnDestroy } from '@caffeinejs/di'
import { afterEach, describe, it, expect, vi } from 'vitest'

import { InlineConfigProvider, JSONConfigProvider, type ConfigHandle } from './config/index.js'
import {
  $t,
  type BootstrapKit,
  type InferSchema,
  kBootstrap,
  kFeatureName,
  type Feature,
  createApplication,
} from './index.js'

// The framework's own block, declared as the application root so a source can be registered against it.
const caffeineSchema = $t.Object({
  caffeine: $t.Object({ name: $t.Optional($t.String()), profiles: $t.Optional($t.List($t.String())) }, { default: {} }),
})
const kConfig = token<ConfigHandle<InferSchema<typeof caffeineSchema>>>(Symbol('app.config'))

// Builds a headless app over an isolated container (no global autowire) with only the explicit binds —
// exercises the singleton-scan discovery path deterministically.
function appWith(configure: (container: CaffeineIoC) => void) {
  const container = new CaffeineIoC({ decorators: false })
  configure(container)
  return createApplication({ container }).build()
}

describe('Application lifecycle', () => {
  it('runs a container OnBootstrap hook during ready() and an OnDestroy hook during close()', async () => {
    const order: string[] = []

    class Beacon implements OnBootstrap, OnDestroy {
      onBootstrap() {
        order.push('bootstrap')
      }

      onDestroy() {
        order.push('destroy')
      }
    }

    const app = appWith(c => c.bind(Beacon, t => t.toClass(Beacon)))

    await app.ready()
    expect(order).toEqual(['bootstrap'])
    await app.run()
    await app.close()
    expect(order).toEqual(['bootstrap', 'destroy'])
  })

  it('fail-fast: a throwing onBootstrap hook aborts ready()', async () => {
    class Boom implements OnBootstrap {
      onBootstrap() {
        throw new Error('boom')
      }
    }

    const app = appWith(c => c.bind(Boom, t => t.toClass(Boom)))

    await expect(app.ready()).rejects.toThrow('boom')
  })

  it('shutdown: a throwing onDestroy hook aggregates, and the container is still disposed', async () => {
    const ran: string[] = []

    class Failing implements OnDestroy {
      onDestroy() {
        ran.push('a')
        throw new Error('e1')
      }
    }
    class Ok implements OnDestroy {
      onDestroy() {
        ran.push('b')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing, t => t.toClass(Failing))
    container.bind(Ok, t => t.toClass(Ok))
    const dispose = vi.spyOn(container, 'dispose')

    const app = createApplication({ container }).build()
    await app.ready()

    await expect(app.close()).rejects.toThrow(AggregateError)
    expect(ran.sort()).toEqual(['a', 'b'])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('installs a feature and bootstraps it', async () => {
    const kSentinel = token<Record<string, unknown>>(Symbol('sentinel'))
    const state: { value: string | undefined } = { value: undefined }

    const probe: Feature = {
      [kFeatureName]: 'probe',
      [kBootstrap](kit: BootstrapKit) {
        state.value = 'hello'
        kit.container.bind(kSentinel, t => t.toValue({ value: state.value }))
        return Promise.resolve()
      },
    }

    const app = createApplication({}).extend(probe)

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kSentinel)).toEqual({ value: 'hello' })
  })
})

describe('application name and profiles', () => {
  // `hostProfiles` reads the real environment, so a stub left behind would leak into the next case.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  @Injectable()
  @Profile('eu')
  class EuOnly {}

  it('defaults name to empty after ready()', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).build()
    await app.ready()

    expect(app.name).toBe('')
  })

  it('reads caffeine.name from a config source', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { name: 'petstore' } })))
      .build()
    await app.ready()

    expect(app.name).toBe('petstore')
  })

  it('applies CAFFEINE__PROFILES to the container', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).build()
    await app.ready()

    expect(app.container.profiles.has('eu')).toBe(true)
  })

  // The container's own set is a profile source in its own right, and the three up-front sources union
  // rather than replace each other: a container built for `test` still picks up what the environment names.
  it('unions the environment onto a user-supplied container', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const app = createApplication({ container }).build()
    await app.ready()

    expect(container.profiles.has('test')).toBe(true)
    expect(container.profiles.has('eu')).toBe(true)
    expect(app.profiles).toEqual(['test', 'eu'])
  })

  it('does not register a @Profile bean without matching config profiles', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container }).build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(false)
  })

  it('registers a @Profile bean when the active profiles include it', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container }).build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(true)
  })

  it('run() resolves to the application name and active profiles', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { name: 'petstore' } })))
      .build()

    // The point: a caller reads post-start identity straight off run(), without keeping the app handle to
    // poll app.name / app.profiles.
    const info = await app.run()
    await app.close()

    expect(info).toEqual({ name: 'petstore', profiles: ['eu'] })
  })

  it('deduplicates the active profiles before applying them', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu,eu,dev')

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).build()
    await app.ready()

    expect(app.profiles).toEqual(['eu', 'dev'])
  })

  // A value that only exists once the tree has resolved cannot decide what that resolve reads, so an inline
  // source never selects a config file overlay. It still reaches the tree, and with nothing named up front
  // the application falls back to it.
  it('ignores a source-declared profile once anything named one up front', async () => {
    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const app = createApplication({ container })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(app.profiles).toEqual(['test'])
    expect(container.profiles.has('eu')).toBe(false)
  })
})

describe('profile-segregated config files', () => {
  const files: string[] = []

  async function writeTmp(name: string, content: string): Promise<string> {
    const path = join(tmpdir(), name)
    await writeFile(path, content, 'utf8')
    files.push(path)
    return path
  }

  afterEach(async () => {
    for (const f of files.splice(0)) {
      await unlink(f).catch(() => undefined)
    }
  })

  it('loads the overlay named by the base file own caffeine.profiles', async () => {
    // End to end, and the reason the file provider reads its own base: nothing named a profile up front, so
    // the base file decides, on the single resolve, which sibling layers over it.
    const base = await writeTmp('app-e2e.json', JSON.stringify({ caffeine: { name: 'base', profiles: ['eu'] } }))
    await writeTmp('app-e2e-eu.json', JSON.stringify({ caffeine: { name: 'eu-app' } }))

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .config(caffeineSchema, kConfig, c => c.source(new JSONConfigProvider(base)))
      .build()
    await app.ready()

    expect(app.name).toBe('eu-app')
    expect(app.profiles).toEqual(['eu'])
  })

  it('loads the overlay named by the container own profiles', async () => {
    const base = await writeTmp('app-ctr.json', JSON.stringify({ caffeine: { name: 'base' } }))
    await writeTmp('app-ctr-test.json', JSON.stringify({ caffeine: { name: 'test-app' } }))

    const app = createApplication({ container: new CaffeineIoC({ decorators: false, profiles: ['test'] }) })
      .config(caffeineSchema, kConfig, c => c.source(new JSONConfigProvider(base)))
      .build()
    await app.ready()

    expect(app.name).toBe('test-app')
    expect(app.profiles).toEqual(['test'])
  })
})
