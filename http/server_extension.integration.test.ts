import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import fp from 'fastify-plugin'
import {
  Controller,
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

function newApp(extension: ServerExtension) {
  const container = new CaffeineIoC()
  container.bind(extension.constructor as never).toValue(extension).extends()

  return createWebApplication(fastifyAdapterFactory(fastify()), { container }).build()
}

describe('ServerExtension discovery', () => {
  it('configures a container-bound extension with the resolved application', async () => {
    const recorder = new Recorder()
    const app = newApp(recorder)
    await app.ready()

    expect(recorder.seen).toBeDefined()
    expect(recorder.seen!.routers.length).toBeGreaterThan(0)
    expect(recorder.seen!.container).toBeDefined()
    expect(recorder.seen!.services.errorHandling).toBeDefined()

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

describe('ServerExtension metadata (enforced by Fastify)', () => {
  it('fails start-up when a declared dependency was never registered', async () => {
    class NeedsMissing extends ServerExtension {
      readonly name = 'needs-missing'
      readonly dependencies = ['nobody-registered-this']

      configure = (): void => {}
    }

    await expect(newApp(new NeedsMissing()).ready())
      .rejects.toThrow(/'nobody-registered-this'.*'needs-missing'/)
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

    const container = new CaffeineIoC()
    container.bind(NeedsCookieLike).toValue(new NeedsCookieLike()).extends()

    const server = fastify()
    // Registered before the application boots, so avvio has loaded it by the time the extension registers.
    server.register(fp((instance, _opts, done) => {
      instance.decorateRequest('sugar', null)
      done()
    }, { name: 'sugar-plugin' }))

    const app = createWebApplication(fastifyAdapterFactory(server), { container }).build()
    await app.ready()

    expect(app.instance.hasRequestDecorator('sugar')).toBe(true)
    await app.close()
  })
})
