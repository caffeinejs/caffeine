import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaffeineIoC, Injectable, Profile, Scopes, token } from '@caffeinejs/di'
import type { OnBootstrap, OnDestroy } from '@caffeinejs/di'
import { afterEach, describe, it, expect, vi } from 'vitest'

import { InlineConfigSource, JSONConfigSource, type InferConfig } from './config/index.js'
import {
  ApplicationHealth,
  ErrHealthIndicatorNotSingleton,
  HealthIndicator,
  type HealthReport,
  up,
} from './health/index.js'
import {
  Application,
  ErrApplicationClosed,
  ErrApplicationRunning,
  ErrApplicationStarted,
  ErrFeatureAlreadyInstalled,
  FeatureBuilder,
  type BootstrapKit,
  type FeatureConfigureKit,
  type FeatureConfigurer,
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type Feature,
  createApplication,
  newConfiguration,
} from './index.js'
import { newNoopLogger, type Logger } from './logger/index.js'
import { $t } from './schema/t.js'
import { ErrShutdownTimeout, type ShutdownSignal, type SignalDispatcher } from './shutdown/index.js'

// The framework's own block, declared as the application root so a source can be registered against it.
const caffeineSchema = $t.Object({
  caffeine: $t.Object({ name: $t.Optional($t.String()), profiles: $t.Optional($t.List($t.String())) }, { default: {} }),
})
const kConfig = token<InferConfig<typeof caffeineSchema>>(Symbol('app.config'))

// Builds a headless app over an isolated container (no global autowire) with only the explicit binds —
// exercises the singleton-scan discovery path deterministically.
function appWith(configure: (container: CaffeineIoC) => void) {
  const container = new CaffeineIoC({ decorators: false })
  configure(container)
  return createApplication({ container })
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

    const app = createApplication({ container })
    await app.ready()

    await expect(app.close()).rejects.toThrow(AggregateError)
    expect(ran.sort()).toEqual(['a', 'b'])
    expect(dispose).toHaveBeenCalledOnce()
  })

  // The store closes with the container, and only an initialized container has the hook that does it. A ready() that
  // fails before then must close it, or the sources it loaded stay open with nobody left to close them.
  it('closes the configuration when ready() fails before the container initializes', async () => {
    const close = vi.fn()
    const conf = newConfiguration(caffeineSchema, kConfig)
      .source({ name: 'watched', load: () => [{ name: 'watched', data: {} }], close })
      .build()
    const misconfigured: Feature = {
      [kFeatureName]: 'misconfigured',
      [kFeatureConfigure]() {
        throw new Error('misconfigured')
      },
    }
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(
      misconfigured,
    )

    await expect(app.ready()).rejects.toThrow('misconfigured')
    expect(close).toHaveBeenCalledOnce()
  })
})

const kSentinel = token<Record<string, unknown>>(Symbol('tracker.sentinel'))

class TrackerBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly #name: string

  #value: string | undefined

  constructor(name: string, configure?: FeatureConfigurer<never, C>) {
    super(configure)
    this.#name = name
  }

  get [kFeatureName](): string {
    return this.#name
  }

  capture(value: string): this {
    this.#value = value
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): Promise<void> {
    const value = this.#value
    kit.container.bind(kSentinel, t => t.toValue({ value }))
    return Promise.resolve()
  }
}

function tracker<C = unknown>(configure?: FeatureConfigurer<TrackerBuilder<C>, C>): Feature<C> {
  return new TrackerBuilder<C>('track', configure as never)
}

/** An instanced feature: the instance folds into the name `.with` deduplicates on. */
function keyed(instance = 'default'): Feature {
  return new TrackerBuilder(instance === 'default' ? 'keyed' : `keyed:${instance}`)
}

describe('Application.with', () => {
  it('installs the feature and bootstraps it', async () => {
    const app = createApplication().with(tracker(t => t.capture('recorded')))

    await app.ready()

    expect(app.container.getOptional(kSentinel)).toEqual({ value: 'recorded' })
    await app.close()
  })

  it('returns the application it was called on', () => {
    const app = createApplication()

    expect(app.with(tracker())).toBe(app)
  })

  it('does not add methods to the application', () => {
    const app = createApplication().with(tracker())

    // @ts-expect-error features no longer contribute methods
    const missing: unknown = app.track
    expect(missing).toBeUndefined()
  })

  it('throws when a feature is installed twice', () => {
    expect(() => createApplication().with(tracker()).with(tracker())).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('throws when a keyed instance is installed twice', () => {
    expect(() => createApplication().with(keyed()).with(keyed())).toThrow(ErrFeatureAlreadyInstalled)
    expect(() => createApplication().with(keyed('orders')).with(keyed('orders'))).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('allows distinct keyed instances', () => {
    const app = createApplication().with(keyed()).with(keyed('orders'))
    expect(app).toBeDefined()
  })
})

const widgetSchema = $t.Object({ widget: $t.Object({ size: $t.Number() }) })
type WidgetConfig = { widget: { size: number } }
const kWidgetConfig = token<WidgetConfig>(Symbol('app.config'))

/** A minimal feature: reads the resolved configuration, then binds what it found. */
class WidgetFeature implements Feature<WidgetConfig> {
  bound: number | undefined

  get [kFeatureName](): string {
    return 'widget'
  }

  [kFeatureConfigure](kit: FeatureConfigureKit<WidgetConfig>): Promise<void> {
    this.bound = kit.config.widget.size
    kit.container.bind(token<number | undefined>('widget.size'), t => t.toValue(this.bound))
    return Promise.resolve()
  }

  [kFeatureBootstrap](): Promise<void> {
    return Promise.resolve()
  }
}

function widgetApp(feature: Feature<never>, size: number) {
  const conf = newConfiguration(widgetSchema, kWidgetConfig)
    .source(new InlineConfigSource({ widget: { size } }))
    .build()
  return createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).addFeature(feature)
}

describe('feature lifecycle', () => {
  // The one ordering guarantee the mechanism rests on: configuration resolves before any feature
  // configures, and binding is still open when it does. Resolving inside `container.init()` would be too
  // late for both.
  it('resolves configuration before a feature configures, while it can still bind', async () => {
    const feature = new WidgetFeature()
    const app = widgetApp(feature as Feature<never>, 42)

    await app.ready()

    expect(feature.bound).toBe(42)
    expect(app.container.get(token<number | undefined>('widget.size'))).toBe(42)
  })

  it('runs a feature that reads no configuration at all', async () => {
    let configured = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      get [kFeatureName](): string {
        return 'noop'
      },
      [kFeatureConfigure](): Promise<void> {
        configured = true
        return Promise.resolve()
      },
      [kFeatureBootstrap](): Promise<void> {
        return Promise.resolve()
      },
    })

    await app.ready()

    expect(configured).toBe(true)
  })

  // A tree that cannot validate is a broken application, and saying so at `ready()` is earlier and more
  // legible than failing at whatever moment a feature first read it.
  it('fails start-up when the configuration cannot be validated, before anything binds', async () => {
    let configured = false

    // The tree carries a string where the schema declares a number.
    const conf = newConfiguration(widgetSchema, kWidgetConfig)
      .source(new InlineConfigSource({ widget: { size: 'not-a-number' } }))
      .build()

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).addFeature({
      get [kFeatureName](): string {
        return 'strict'
      },
      [kFeatureConfigure](): Promise<void> {
        configured = true
        return Promise.resolve()
      },
      [kFeatureBootstrap](): Promise<void> {
        return Promise.resolve()
      },
    })

    await expect(app.ready()).rejects.toThrow()
    expect(configured).toBe(false)
  })

  it('configures before the container initializes, and bootstraps after', async () => {
    const order: string[] = []

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      [kFeatureName]: 'order',
      [kFeatureConfigure](): void {
        order.push('configure')
      },
      [kFeatureBootstrap](): void {
        order.push('bootstrap')
      },
    })

    const init = app.container.init.bind(app.container)
    app.container.init = async () => {
      order.push('init')
      await init()
    }

    await app.ready()

    expect(order).toEqual(['configure', 'init', 'bootstrap'])
  })
})

describe('feature bootstrap', () => {
  // Bootstrap is only for looking bindings up after `container.init()`. A feature that has nothing to look up
  // should not have to say so, which is why the hook is optional.
  it('readies a feature that declares no bootstrap hook', async () => {
    let configured = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      [kFeatureName]: 'configure-only',
      [kFeatureConfigure](): void {
        configured = true
      },
    })

    await app.ready()

    expect(configured).toBe(true)
  })

  // The logger feature configures in the same phase as every other feature, so a feature cannot read the final
  // logger while configuring. By bootstrap it is settled, and the kit must carry that one, not the eager default
  // the application started with: otherwise `.logger(b => b.use(...))` would not reach feature code.
  it('hands bootstrap the logger the application configured', async () => {
    const custom: Logger = { ...newNoopLogger() }
    let seen: Logger | undefined

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .logger(b => b.use(custom))
      .addFeature({
        [kFeatureName]: 'reads-logger',
        [kFeatureConfigure](): void {
          // Nothing to bind.
        },
        [kFeatureBootstrap](kit: BootstrapKit): void {
          seen = kit.logger
        },
      })

    await app.ready()

    expect(seen).toBe(custom)
  })
})

describe('configuring a started application', () => {
  // `ready()` reads the feature list once. A change made after that point would be dropped without a word, so
  // it is refused instead: a misplaced call must not look like it worked.
  const late: Feature = {
    [kFeatureName]: 'late',
    [kFeatureConfigure]() {
      // Nothing to bind.
    },
    [kFeatureBootstrap]() {
      // Nothing to register.
    },
  }

  it('refuses configuration once ready() has completed', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
    await app.ready()

    expect(() => app.with(late)).toThrow(ErrApplicationStarted)
    expect(() => app.addFeature(late)).toThrow(ErrApplicationStarted)
    expect(() => app.shutdown(s => s.signals(false))).toThrow(ErrApplicationStarted)
  })

  it('refuses configuration while ready() is still in flight', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
    const ready = app.ready()

    expect(() => app.with(late)).toThrow(ErrApplicationStarted)

    await ready
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
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
    await app.ready()

    expect(app.name).toBe('')
  })

  it('reads caffeine.name from a config source', async () => {
    const conf = newConfiguration(caffeineSchema, kConfig)
      .source(new InlineConfigSource({ caffeine: { name: 'petstore' } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })
    await app.ready()

    expect(app.name).toBe('petstore')
  })

  it('applies CAFFEINE__PROFILES to the container', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
    await app.ready()

    expect(app.container.profiles.has('eu')).toBe(true)
  })

  // The container's own set is a profile source in its own right, and the three up-front sources union
  // rather than replace each other: a container built for `test` still picks up what the environment names.
  it('unions the environment onto a user-supplied container', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const app = createApplication({ container })
    await app.ready()

    expect(container.profiles.has('test')).toBe(true)
    expect(container.profiles.has('eu')).toBe(true)
    expect(app.profiles).toEqual(['test', 'eu'])
  })

  it('does not register a @Profile bean without matching config profiles', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container })
    await app.ready()

    expect(container.has(EuOnly)).toBe(false)
  })

  it('registers a @Profile bean when the active profiles include it', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const container = new CaffeineIoC({ decorators: false })
    container.bind(EuOnly, t => t.toSelf())
    const app = createApplication({ container })
    await app.ready()

    expect(container.has(EuOnly)).toBe(true)
  })

  it('run() resolves to the application name and active profiles', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu')

    const conf = newConfiguration(caffeineSchema, kConfig)
      .source(new InlineConfigSource({ caffeine: { name: 'petstore' } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

    // The point: a caller reads post-start identity straight off run(), without keeping the app handle to
    // poll app.name / app.profiles.
    const info = await app.run()
    await app.close()

    expect(info).toEqual({ name: 'petstore', profiles: ['eu'] })
  })

  it('deduplicates the active profiles before applying them', async () => {
    vi.stubEnv('CAFFEINE__PROFILES', 'eu,eu,dev')

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
    await app.ready()

    expect(app.profiles).toEqual(['eu', 'dev'])
  })

  // A value that only exists once the tree has resolved cannot decide what that resolve reads, so an inline
  // source never selects a config file overlay. It still reaches the tree, and with nothing named up front
  // the application falls back to it.
  it('ignores a source-declared profile once anything named one up front', async () => {
    const container = new CaffeineIoC({ decorators: false, profiles: ['test'] })
    const conf = newConfiguration(caffeineSchema, kConfig)
      .source(new InlineConfigSource({ caffeine: { profiles: ['eu'] } }))
      .build()
    const app = createApplication({ container, config: conf })
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

    const conf = newConfiguration(caffeineSchema, kConfig).source(new JSONConfigSource(base)).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })
    await app.ready()

    expect(app.name).toBe('eu-app')
    expect(app.profiles).toEqual(['eu'])
  })

  it('loads the overlay named by the container own profiles', async () => {
    const base = await writeTmp('app-ctr.json', JSON.stringify({ caffeine: { name: 'base' } }))
    await writeTmp('app-ctr-test.json', JSON.stringify({ caffeine: { name: 'test-app' } }))

    const conf = newConfiguration(caffeineSchema, kConfig).source(new JSONConfigSource(base)).build()
    const app = createApplication({
      container: new CaffeineIoC({ decorators: false, profiles: ['test'] }),
      config: conf,
    })
    await app.ready()

    expect(app.name).toBe('test-app')
    expect(app.profiles).toEqual(['test'])
  })
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Records signal wiring without touching the real process. */
class FakeDispatcher implements SignalDispatcher {
  readonly handlers = new Map<ShutdownSignal, () => void>()
  exitCode: number | undefined

  on(signal: ShutdownSignal, handler: () => void): void {
    this.handlers.set(signal, handler)
  }

  off(signal: ShutdownSignal): void {
    this.handlers.delete(signal)
  }

  exit(): void {}
  setExitCode(code: number): void {
    this.exitCode = code
  }

  warn(): void {}
  error(): void {}
}

// A headless application had no signal handling and no drain at all before graceful shutdown moved into
// Application — a Kafka consumer with no HTTP server was simply killed mid-message.
describe('headless application shutdown', () => {
  it('refuses traffic before the drain delay and disposes the container after it', async () => {
    let hookAt = 0

    class Recorder implements OnDestroy {
      onDestroy() {
        hookAt = Date.now()
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Recorder, t => t.toSelf())

    const app = createApplication({ container }).shutdown(s => s.drainDelay(300))

    await app.run()

    expect(app.availability.ready).toBe('accepting')
    expect(app.availability.started).toBe(true)

    const startedAt = Date.now()
    const closing = app.close()

    // No await in between: the flip has to be immediate, not deferred until the delay elapses.
    expect(app.availability.draining).toBe(true)
    expect(app.availability.ready).toBe('refusing')
    expect(app.availability.live).toBe('correct')

    await closing

    expect(hookAt - startedAt).toBeGreaterThanOrEqual(250)
    expect(app.availability.live).toBe('broken')
  })

  it('skips the wait when no drain delay is configured', async () => {
    const app = createApplication()
    await app.run()

    const startedAt = Date.now()
    await app.close()

    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  it('joins a second close instead of starting another one', async () => {
    let hooks = 0

    class Recorder implements OnDestroy {
      onDestroy() {
        hooks++
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Recorder, t => t.toSelf())

    const app = createApplication({ container }).shutdown(s => s.drainDelay(100))
    await app.run()

    await Promise.all([app.close(), app.close()])

    expect(hooks).toBe(1)
  })

  it('installs the configured signals and drains when one arrives', async () => {
    const dispatcher = new FakeDispatcher()
    const app = createApplication().shutdown(s => s.drainDelay(50).signals(['SIGTERM']).dispatcher(dispatcher))

    await app.run()

    expect(dispatcher.handlers.has('SIGTERM')).toBe(true)

    dispatcher.handlers.get('SIGTERM')!()
    await vi.waitFor(() => expect(dispatcher.exitCode).toBe(0))

    expect(app.availability.draining).toBe(true)
    // Handlers are removed only once the shutdown has finished, so a second signal can still force an exit.
    expect(dispatcher.handlers.size).toBe(0)
  })

  it('installs nothing under a test runner by default', async () => {
    const before = process.listenerCount('SIGTERM')
    const app = createApplication()

    await app.run()

    expect(process.listenerCount('SIGTERM')).toBe(before)

    await app.close()
  })

  // The teardown budget used to be the HTTP application's alone, so a headless consumer whose destroy hook hung
  // rode straight past the termination grace period into SIGKILL with nothing said about it.
  it('reports a destroy hook that overruns the teardown budget', async () => {
    class Slow implements OnDestroy {
      async onDestroy() {
        await sleep(400)
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Slow, t => t.toSelf())

    const app = createApplication({ container }).shutdown(s => s.drainDelay(0).shutdownTimeout(100))
    await app.run()

    const error = (await app.close().catch((error: unknown) => error)) as AggregateError

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect((error.errors[0] as ErrShutdownTimeout).timeoutMs).toBe(100)
  })

  it('still disposes the container when a destroy hook throws', async () => {
    class Failing implements OnDestroy {
      onDestroy() {
        throw new Error('hook failed')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing, t => t.toSelf())

    const app = createApplication({ container })
    await app.run()

    await expect(app.close()).rejects.toThrow(AggregateError)
    await sleep(0)

    expect(app.availability.live).toBe('broken')
  })
})

// A platform whose start can be held open, recording what the lifecycle asked of it and in which order.
class Platform extends Application {
  readonly calls: string[] = []
  readonly listening = Promise.withResolvers<void>()

  protected override async start(): Promise<void> {
    this.calls.push('start')
    await this.listening.promise
    this.calls.push('listening')
  }

  protected override stop(): Promise<void> {
    this.calls.push('stop')
    return Promise.resolve()
  }
}

// Counts every handler installed: a second set is what a repeated run() used to leave behind.
class CountingDispatcher extends FakeDispatcher {
  installed = 0

  override on(signal: ShutdownSignal, handler: () => void): void {
    this.installed++
    super.on(signal, handler)
  }
}

// Closing is what every caller does on the way out — a signal handler, a host stopping a worker, a test's
// cleanup — so it has to be safe wherever the application is in its lifecycle, and to report a failed shutdown once.
describe('closing at any point of the lifecycle', () => {
  class Recorder implements OnDestroy {
    static destroyed = 0

    onDestroy() {
      Recorder.destroyed++
    }
  }

  afterEach(() => {
    Recorder.destroyed = 0
  })

  // Nothing was brought up, so there is nothing to tear down — but a close is final all the same, or the rule that
  // a closed application is not started again would have an exception nobody expects.
  it('closes an application that was never readied for good, tearing nothing down', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const dispose = vi.spyOn(container, 'dispose')
    const app = createApplication({ container })

    await app.close()

    expect(dispose).not.toHaveBeenCalled()
    expect(app.availability.live).toBe('broken')
    await expect(app.ready()).rejects.toThrow(ErrApplicationClosed)
  })

  it('waits for a ready() in flight, then tears down what it brought up', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Recorder, t => t.toSelf())
    const app = createApplication({ container })

    const booting = app.ready()
    const closing = app.close()

    await booting
    await closing

    expect(Recorder.destroyed).toBe(1)
  })

  // Stopping a platform while it is still starting races the start: under Fastify, the socket then opens after the
  // close resolved, and the process never exits.
  it('lets a start under way finish, then stops what it opened', async () => {
    const app = new Platform()

    const running = app.run()
    await vi.waitFor(() => expect(app.calls).toEqual(['start']))

    const closing = app.close()
    app.listening.resolve()

    await running
    await closing

    expect(app.calls).toEqual(['start', 'listening', 'stop'])
    expect(app.availability.ready).toBe('refusing')
  })

  it('starts nothing when the close arrives while run() is still booting', async () => {
    const dispatcher = new CountingDispatcher()
    const app = new Platform().shutdown(s => s.signals(['SIGTERM']).dispatcher(dispatcher))
    app.listening.resolve()

    const running = app.run()
    const closing = app.close()

    await expect(running).rejects.toThrow(ErrApplicationClosed)
    await closing

    expect(app.calls).toEqual(['stop'])
    expect(dispatcher.installed).toBe(0)
  })

  it('tears down after a failed ready() without replacing its error, logging what the teardown hit', async () => {
    class Failing implements OnDestroy {
      onDestroy() {
        throw new Error('teardown failed')
      }
    }

    const logged: unknown[][] = []
    const logger: Logger = { ...newNoopLogger(), error: (...args: unknown[]) => void logged.push(args) }
    const failing: Feature = {
      [kFeatureName]: 'failing',
      [kFeatureConfigure]() {},
      [kFeatureBootstrap]() {
        throw new Error('boot failed')
      },
    }
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing, t => t.toSelf())
    const app = createApplication({ container, logger }).with(failing)

    const boot = async (): Promise<void> => {
      try {
        await app.ready()
      } finally {
        await app.close()
      }
    }

    await expect(boot()).rejects.toThrow('boot failed')
    expect(logged).toHaveLength(1)
    expect(app.availability.live).toBe('broken')
  })

  it('skips the drain delay for an application that never served', async () => {
    const app = createApplication().shutdown(s => s.drainDelay('5s'))
    await app.ready()

    const startedAt = Date.now()
    await app.close()

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(app.availability.draining).toBe(true)
  })

  it('reports a failed shutdown to the call that started it, and to no other', async () => {
    class Failing implements OnDestroy {
      onDestroy() {
        throw new Error('hook failed')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing, t => t.toSelf())
    const app = createApplication({ container })
    await app.run()

    const first = app.close()
    const joined = app.close()

    await expect(first).rejects.toThrow(AggregateError)
    await expect(joined).resolves.toBeUndefined()
    await expect(app.close()).resolves.toBeUndefined()
  })

  it('boots once when ready() is called again while booting', async () => {
    let configured = 0
    const counting: Feature = {
      [kFeatureName]: 'counting',
      [kFeatureConfigure]() {
        configured++
      },
    }
    const app = createApplication().with(counting)

    await Promise.all([app.ready(), app.ready()])

    expect(configured).toBe(1)
    await app.close()
  })
})

// An application runs once. A host that restarts one builds a new one — Watt a new worker, Kubernetes a new process
// — because nothing it brought up can be brought up again: the container is disposed, the configuration closed and,
// under Fastify, the server refuses to listen again.
describe('running once', () => {
  it('refuses a second run(), even while the first is still booting, and starts once', async () => {
    const dispatcher = new CountingDispatcher()
    const app = new Platform().shutdown(s => s.signals(['SIGTERM']).dispatcher(dispatcher))
    app.listening.resolve()

    const first = app.run()

    await expect(app.run()).rejects.toThrow(ErrApplicationRunning)
    await first

    expect(app.calls).toEqual(['start', 'listening'])
    expect(dispatcher.installed).toBe(1)

    await app.close()

    expect(dispatcher.handlers.size).toBe(0)
  })

  it('refuses to run a closed application, reporting the close rather than the earlier run', async () => {
    const app = new Platform()
    app.listening.resolve()
    await app.run()
    await app.close()

    await expect(app.run()).rejects.toThrow(ErrApplicationClosed)
    expect(app.calls).toEqual(['start', 'listening', 'stop'])
  })

  it('refuses to ready a closed application, while a ready() already under way keeps its outcome', async () => {
    const app = createApplication()

    const booting = app.ready()
    const closing = app.close()

    await expect(booting).resolves.toBeUndefined()
    await closing
    await expect(app.ready()).rejects.toThrow(ErrApplicationClosed)
  })
})

// Health belongs to every application, not to an HTTP server: a headless worker answers the same probes, from the
// same indicators, to whatever polls it — Watt, a custom endpoint, a test.
describe('application health', () => {
  class Database extends HealthIndicator {
    get name(): string {
      return 'database'
    }

    check(): HealthReport {
      return up()
    }
  }

  it('follows the lifecycle, evaluating the indicators bound in the container', async () => {
    const app = appWith(container => container.bind(Database, t => t.toSelf().extends(HealthIndicator)))
    await app.ready()

    const health = app.container.get(ApplicationHealth)

    expect((await health.readiness()).ok).toBe(false)

    await app.run()
    const running = await health.readiness()

    expect(running.ok).toBe(true)
    expect(running.outcomes.map(outcome => outcome.name)).toEqual(['database'])

    const closing = app.close()

    expect((await health.readiness()).ok).toBe(false)

    await closing
  })

  it('rejects a non-singleton indicator when the service is first built', async () => {
    const app = appWith(container =>
      container.bind(Database, t => t.toSelf().lifetime(Scopes.TRANSIENT).extends(HealthIndicator)),
    )
    await app.ready()

    try {
      expect(() => app.container.get(ApplicationHealth)).toThrow(ErrHealthIndicatorNotSingleton)
    } finally {
      await app.close()
    }
  })
})
