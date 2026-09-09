import { CaffeineIoC, Injectable, Profile, token } from '@caffeinejs/di'
import type { OnBootstrap, OnDestroy } from '@caffeinejs/di'
import { describe, it, expect, vi } from 'vitest'

import { InlineConfigProvider, type ConfigHandle } from './config/index.js'
import {
  $t,
  type BootstrapKit,
  type InferSchema,
  feature,
  kBootstrap,
  kFeatureName,
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

  it('installs a feature and rides the configure() path', async () => {
    const kSentinel = token<Record<string, unknown>>(Symbol('sentinel'))
    const state: { value: string | undefined } = { value: undefined }

    const probe = feature('probe', () => ({
      [kFeatureName]: 'probe',
      probe(value: string) {
        state.value = value
      },
      [kBootstrap](kit: BootstrapKit) {
        kit.container.bind(kSentinel, t => t.toValue({ value: state.value }))
        return Promise.resolve()
      },
    }))

    const app = createApplication({}).extend(probe, p => p.probe('hello'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kSentinel)).toEqual({ value: 'hello' })
  })
})

describe('application name and profiles', () => {
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

  it('applies caffeine.profiles to the container', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(app.container.profiles.has('eu')).toBe(true)
  })

  it('unions config profiles onto a user-supplied container', async () => {
    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const app = createApplication({ container })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(container.profiles.has('test')).toBe(true)
    expect(container.profiles.has('eu')).toBe(true)
  })

  it('does not register a @Profile bean without matching config profiles', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container }).build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(false)
  })

  it('registers a @Profile bean when caffeine.profiles includes it', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container })
      .config(caffeineSchema, kConfig, c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(true)
  })
})
