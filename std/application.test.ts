import { describe, it, expect, vi } from 'vitest'
import { CaffeineIoC, Injectable, Profile, Scopes } from '@caffeinejs/di'
import { InlineConfigProvider } from './config/index.js'
import {
  type Plugin,
  OnApplicationReady,
  OnApplicationRun,
  OnApplicationShutdown,
  OnPreApplicationShutdown,
  createApplication,
} from './index.js'

// Builds a headless app over an isolated container (no global autowire) with only the explicit binds —
// exercises the singleton-scan discovery path deterministically.
function appWith(configure: (container: CaffeineIoC) => void) {
  const container = new CaffeineIoC({ decorators: false })
  configure(container)
  return createApplication({ container }).build()
}

describe('Application lifecycle', () => {
  it('fires the lifecycle decorators across ready/run/close, in order', async () => {
    const order: string[] = []

    class Beacon {
      @OnApplicationReady()
      onReady() {
        order.push('ready')
      }

      @OnApplicationRun()
      onRun() {
        order.push('run')
      }

      @OnPreApplicationShutdown()
      onPre() {
        order.push('pre')
      }

      @OnApplicationShutdown()
      onDown() {
        order.push('down')
      }
    }

    const app = appWith(c => c.bind(Beacon).toClass(Beacon))

    await app.ready()
    expect(order).toEqual(['ready'])
    await app.run()
    expect(order).toEqual(['ready', 'run'])
    await app.close()
    expect(order).toEqual(['ready', 'run', 'pre', 'down'])
  })

  it('runs programmatic listeners, passing the application instance', async () => {
    const seen: unknown[] = []
    const app = appWith(() => {})

    app.on('application:ready', a => {
      seen.push(a)
    })
    await app.ready()

    expect(seen).toEqual([app])
  })

  it('off removes a listener before it fires', async () => {
    const app = appWith(() => {})
    const fn = vi.fn()

    app.on('application:ready', fn).off('application:ready', fn)
    await app.ready()

    expect(fn).not.toHaveBeenCalled()
  })

  it('once registers a listener that runs when the event fires', async () => {
    const app = appWith(() => {})
    const fn = vi.fn()

    app.once('application:ready', fn)
    await app.ready()

    expect(fn).toHaveBeenCalledOnce()
  })

  it('rejects registering the same listener twice for an event', () => {
    const app = appWith(() => {})
    const fn = (): void => {}

    app.on('application:ready', fn)
    expect(() => app.on('application:ready', fn)).toThrow(/already registered/)
  })

  it('fail-fast: a throwing ready hook aborts ready()', async () => {
    class Boom {
      @OnApplicationReady()
      go() {
        throw new Error('boom')
      }
    }

    const app = appWith(c => c.bind(Boom).toClass(Boom))

    await expect(app.ready()).rejects.toThrow('boom')
  })

  it('best-effort shutdown: every hook runs, errors aggregate, and the container is still disposed', async () => {
    const ran: string[] = []

    class Failing {
      @OnApplicationShutdown()
      a() {
        ran.push('a')
        throw new Error('e1')
      }
    }
    class Ok {
      @OnApplicationShutdown()
      b() {
        ran.push('b')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing).toClass(Failing)
    container.bind(Ok).toClass(Ok)
    const dispose = vi.spyOn(container, 'dispose')

    const app = createApplication({ container }).build()
    await app.ready()

    await expect(app.close()).rejects.toThrow(AggregateError)
    expect(ran.sort()).toEqual(['a', 'b'])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not fire hooks on non-singleton beans', async () => {
    const fired = vi.fn()

    class Transient {
      @OnApplicationReady()
      go() {
        fired()
      }
    }

    const app = appWith(c => c.bind(Transient).toClass(Transient).lifetime(Scopes.TRANSIENT))
    await app.ready()

    expect(fired).not.toHaveBeenCalled()
  })

  it('discovers hook beans via onBindingRegistered on an autowired container', async () => {
    const app = createApplication().build()
    await app.ready()

    // GlobalWarmup (module scope, @Injectable) is picked up by autoWire and its ready hook fires.
    expect(warmups).toContain('warm')
  })

  it('installs a plugin method and rides the configure() path', async () => {
    const kSentinel = Symbol('sentinel')
    const state: { value: string | undefined } = { value: undefined }

    function probe(): Plugin<{ probe: (value: string) => void }> {
      return {
        name: 'probe',
        install(ctx) {
          ctx.addService({
            get name() {
              return 'probe'
            },
            bootstrap(kit) {
              kit.container.bind(kSentinel).toValue({ value: state.value })
              return Promise.resolve()
            },
          })
          return {
            probe: (value: string) => {
              state.value = value
            },
          }
        },
      }
    }

    const app = createApplication({}).extend(probe())
    expect(typeof app.probe).toBe('function')
    app.probe('hello')

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
      .config(c => c.source(new InlineConfigProvider({ caffeine: { name: 'petstore' } })))
      .build()
    await app.ready()

    expect(app.name).toBe('petstore')
  })

  it('applies caffeine.profiles to the container', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .config(c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(app.container.profiles.has('eu')).toBe(true)
  })

  it('unions config profiles onto a user-supplied container', async () => {
    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const app = createApplication({ container })
      .config(c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(container.profiles.has('test')).toBe(true)
    expect(container.profiles.has('eu')).toBe(true)
  })

  it('does not register a @Profile bean without matching config profiles', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly).toSelf()
    const app = createApplication({ container }).build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(false)
  })

  it('registers a @Profile bean when caffeine.profiles includes it', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly).toSelf()
    const app = createApplication({ container })
      .config(c => c.source(new InlineConfigProvider({ caffeine: { profiles: ['eu'] } })))
      .build()
    await app.ready()

    expect(container.has(EuOnly)).toBe(true)
  })
})

const warmups: string[] = []

@Injectable()
class GlobalWarmup {
  @OnApplicationReady()
  warm() {
    warmups.push('warm')
  }
}

void [GlobalWarmup]
