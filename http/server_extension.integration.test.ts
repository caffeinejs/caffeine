import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  defineFeature,
  kBootstrap,
  kExtensionStage,
  kFeatureName,
  type BootstrapKit,
  type ExtensionStage,
  type Feature,
} from '@caffeinejs/std'
import fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { describe, it, expect } from 'vitest'

import {
  Controller,
  ErrorHandlerProvider,
  Get,
  ServerExtension,
  type ServerExtensionContext,
  createWebApplication,
  fastifyAdapterFactory,
} from './index.js'

@Controller('/ping')
class PingController {
  @Get('/')
  ping() {
    return { ok: true }
  }
}
void [PingController]

/** Records what it was handed, so the test can assert the application was already resolved. */
class Recorder extends ServerExtension {
  readonly name = 'recorder'
  seen: ServerExtensionContext | undefined

  configure = (ctx: ServerExtensionContext): void => {
    this.seen = ctx
  }
}

/**
 * The registration path a feature uses: bind the extension under its own key, then hand that key to the
 * application's extensions. `slow` puts an await before the registration, which is what proves the ordering
 * comes from the install position rather than from when the hook got there.
 */
function featureFor(extension: ServerExtension, slow = false): Feature {
  // One key per registration rather than the constructor: two extensions of the same class are two
  // registrations, and keying by the class would have the second overwrite the first.
  const key = token<ServerExtension>(Symbol(`ext.${extension.name}`))

  return defineFeature({
    name: extension.name,
    install(ctx) {
      ctx.addFeature({
        [kFeatureName]: extension.name,

        async [kBootstrap](kit: BootstrapKit): Promise<void> {
          if (slow) {
            await Promise.resolve()
          }

          kit.container.bind(key, t => t.toValue(extension))
          kit.extensions.add(key)
        },
      })
    },
  })
}

function newApp(extension: ServerExtension, server: FastifyInstance = fastify()) {
  return createWebApplication(fastifyAdapterFactory(server), { container: new CaffeineIoC() })
    .extend(featureFor(extension))
    .build()
}

describe('ServerExtension registration', () => {
  it('configures a registered extension with the resolved application', async () => {
    const recorder = new Recorder()
    const app = newApp(recorder)
    await app.ready()

    expect(recorder.seen).toBeDefined()
    expect(recorder.seen!.routeGroups.length).toBeGreaterThan(0)
    expect(recorder.seen!.server).toBeDefined()
    // What a first-party feature produced is reached through the container, exactly as an application would.
    expect(recorder.seen!.container.get(ErrorHandlerProvider)).toBeDefined()

    expect((await app.fetch('/ping')).status).toBe(200)
    await app.close()
  })

  it('registers it as a named Fastify plugin', async () => {
    const recorder = new Recorder()
    const app = newApp(recorder)
    await app.ready()

    expect(app.instance.printPlugins()).toContain('recorder')
    await app.close()
  })

  // Binding is half the act: nothing reaches the server until the key is handed to `kit.extensions`.
  it('ignores an extension that was bound but never registered', async () => {
    const recorder = new Recorder()
    const container = new CaffeineIoC()
    container.bind(Recorder, t => t.toValue(recorder))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container }).build()
    await app.ready()

    expect(recorder.seen).toBeUndefined()
    await app.close()
  })

  it('lets an extension decorate the root, reaching the controller contexts registered afterwards', async () => {
    class Decorates extends ServerExtension {
      readonly name = 'decorates'

      configure = (ctx: ServerExtensionContext): void => {
        ctx.server.decorateRequest('extensionMark', 'set')
      }
    }

    const app = newApp(new Decorates())
    await app.ready()

    expect(app.instance.hasRequestDecorator('extensionMark')).toBe(true)
    await app.close()
  })

  it('fails start-up when the extension throws, and the failure is attributable', async () => {
    class Refuses extends ServerExtension {
      readonly name = 'refuses'

      configure = (): void => {
        throw new Error('this extension cannot work here')
      }
    }

    await expect(newApp(new Refuses()).ready()).rejects.toThrow('this extension cannot work here')
  })
})

/**
 * The pair the ordering cases are written against: one extension puts something on the server, the other one
 * uses it. Asserting through Fastify rather than through a recorded array is the point — a wrong order has to
 * fail the way it would in an application, not fail a claim about bookkeeping.
 */
class ProviderExtension extends ServerExtension {
  readonly name = 'provider'

  configure = (ctx: ServerExtensionContext): void => {
    ctx.server.decorate('greeting', 'hello')
    ctx.server.decorateReply('sendGreeting', function (this: { send(payload: unknown): unknown }) {
      return this.send({ greeting: 'hello' })
    })
  }
}

class ConsumerExtension extends ServerExtension {
  readonly name = 'consumer'
  readonly dependencies = ['provider']
  readonly decorators = { fastify: ['greeting'], reply: ['sendGreeting'] }

  seen: string | undefined

  configure = (ctx: ServerExtensionContext): void => {
    this.seen = (ctx.server as unknown as { greeting: string }).greeting
    ctx.server.get('/greet', (_req, reply) => (reply as unknown as { sendGreeting(): unknown }).sendGreeting())
  }
}

/** Declares only `dependencies`, so it is that assertion — not the decorator one — that reports a bad order. */
class DependentConsumerExtension extends ServerExtension {
  readonly name = 'dependent-consumer'
  readonly dependencies = ['provider']

  configure = (): void => {}
}

/** As above, minus the metadata — so the ordering is doing the work with no assertion to fall back on. */
class BareConsumerExtension extends ServerExtension {
  readonly name = 'bare-consumer'

  seen: string | undefined

  configure = (ctx: ServerExtensionContext): void => {
    this.seen = (ctx.server as unknown as { greeting: string }).greeting
  }
}

function appWith(...features: Feature[]) {
  const app = createWebApplication(fastifyAdapterFactory(fastify()), { container: new CaffeineIoC() })
  for (const feature of features) {
    app.extend(feature)
  }
  return app.build()
}

/**
 * The stage bands, exercised end to end.
 *
 * The framework's own wiring has to bracket everything a package contributes, whatever order the
 * application's `.extend(...)` calls happen to be written in — that is the whole reason `kExtensionStage`
 * exists, and install order alone cannot express it.
 */
describe('ServerExtension stages', () => {
  class Staged extends ServerExtension {
    readonly name: string
    readonly [kExtensionStage]?: ExtensionStage

    constructor(
      name: string,
      private readonly log: string[],
      stage?: ExtensionStage,
    ) {
      super()
      this.name = name
      this[kExtensionStage] = stage
    }

    configure = (): void => {
      this.log.push(this.name)
    }
  }

  it('runs core first and fallback last, against the install order', async () => {
    const log: string[] = []
    const app = appWith(
      featureFor(new Staged('late', log, 'fallback')),
      featureFor(new Staged('plain', log)),
      featureFor(new Staged('early', log, 'core')),
    )

    await app.ready()

    expect(log).toEqual(['early', 'plain', 'late'])
    await app.close()
  })

  // An extension that says nothing is a third-party one, and must never land in a framework band.
  it('treats an unmarked extension as default', async () => {
    const log: string[] = []
    const app = appWith(featureFor(new Staged('first', log)), featureFor(new Staged('second', log)))

    await app.ready()

    expect(log).toEqual(['first', 'second'])
    await app.close()
  })

  // The not-found handler is `fallback` for a reason: a fallback serving files needs whatever an extension
  // decorated the server with, and it derives the owned paths from every provider already registered.
  it('registers the framework not-found handler after a package extension', async () => {
    const log: string[] = []
    const app = appWith(featureFor(new Staged('package', log)))

    await app.ready()

    expect(log).toEqual(['package'])
    // Nothing matched, and the fallback chain the `fallback` stage installed is what answered.
    expect((await app.fetch('/nothing-here')).status).toBe(404)
    await app.close()
  })
})

describe('ServerExtension ordering', () => {
  it('runs extensions in the order their features were installed', async () => {
    const provider = new ProviderExtension()
    const consumer = new ConsumerExtension()
    const app = appWith(featureFor(provider), featureFor(consumer))

    await app.ready()

    expect(consumer.seen).toBe('hello')
    expect(await (await app.fetch('/greet')).json()).toEqual({ greeting: 'hello' })
    await app.close()
  })

  // `dependencies` is asserted, never reordered: the fix is to reorder the `.extend(...)` calls.
  it('fails start-up when a dependency is installed after its dependent', async () => {
    const app = appWith(featureFor(new DependentConsumerExtension()), featureFor(new ProviderExtension()))

    await expect(app.ready()).rejects.toThrow(/'provider'.*'dependent-consumer'/)
  })

  it('starts the same pair when the dependency is installed first', async () => {
    const app = appWith(featureFor(new ProviderExtension()), featureFor(new DependentConsumerExtension()))

    await expect(app.ready()).resolves.toBeUndefined()
    await app.close()
  })

  // The regression the install position exists to prevent: under discovery-by-binding, the await moved the
  // provider behind the consumer and the decoration was not there yet.
  it('keeps the install order when the earlier feature awaits before registering', async () => {
    const provider = new ProviderExtension()
    const consumer = new ConsumerExtension()
    const app = appWith(featureFor(provider, true), featureFor(consumer))

    await app.ready()

    expect(consumer.seen).toBe('hello')
    expect(await (await app.fetch('/greet')).json()).toEqual({ greeting: 'hello' })
    await app.close()
  })

  it('orders an extension that declares no dependencies just the same', async () => {
    const consumer = new BareConsumerExtension()
    const app = appWith(featureFor(new ProviderExtension(), true), featureFor(consumer))

    await app.ready()

    expect(consumer.seen).toBe('hello')
    await app.close()
  })
})

describe('ServerExtension metadata (enforced by Fastify)', () => {
  it('fails start-up when a declared dependency was never registered', async () => {
    class NeedsMissing extends ServerExtension {
      readonly name = 'needs-missing'
      readonly dependencies = ['nobody-registered-this']

      configure = (): void => {}
    }

    await expect(newApp(new NeedsMissing()).ready()).rejects.toThrow(/'nobody-registered-this'.*'needs-missing'/)
  })

  it('fails start-up when a required decorator is absent', async () => {
    class NeedsDecorator extends ServerExtension {
      readonly name = 'needs-decorator'
      readonly decorators = { request: ['nope'] }

      configure = (): void => {}
    }

    await expect(newApp(new NeedsDecorator()).ready()).rejects.toThrow(/nope/)
  })

  it('starts when the required decorator was registered by a plugin on the same instance', async () => {
    class NeedsCookieLike extends ServerExtension {
      readonly name = 'needs-cookie-like'
      readonly decorators = { request: ['sugar'] }

      configure = (): void => {}
    }

    const server = fastify()
    // Registered before the application boots, so avvio has loaded it by the time the extension registers.
    server.register(
      fp(
        (instance, _opts, done) => {
          instance.decorateRequest('sugar', null)
          done()
        },
        { name: 'sugar-plugin' },
      ),
    )

    const app = newApp(new NeedsCookieLike(), server)
    await app.ready()

    expect(app.instance.hasRequestDecorator('sugar')).toBe(true)
    await app.close()
  })
})
