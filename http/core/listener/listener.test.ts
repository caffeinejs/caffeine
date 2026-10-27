import { type AddressInfo, createServer } from 'node:net'

import {
  createApplication,
  ErrApplicationStarted,
  FeatureBuilder,
  kFeatureName,
  newConfiguration,
  type FeatureConfigureKit,
} from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { bindTo, type WebApplication } from '../../index.js'
import { createWebApplication, newRouter } from '../../platform/fastify/index.js'
import { listenersOf, type ListenerConfigurer } from './listener.js'

/**
 * Listeners are a list the application keeps: the application adds to it with `.listener(...)`, a feature with
 * `listenersOf(kit).add(...)`. A name is taken once, whoever takes it, so a router bound to it is never served by
 * the wrong server.
 */

const listener = { host: '127.0.0.1', port: 0 }

// A port nothing listens on: the system hands one out, and it is given back at once.
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** A feature shipping a listener of its own, the way a metrics feature ships its port. */
class Probe<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'probe'

  readonly #name: string
  readonly #listener: ListenerConfigurer<C> | undefined

  constructor(name: string, listener?: ListenerConfigurer<C>) {
    super()
    this.#name = name
    this.#listener = listener
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    listenersOf(kit).add(this.#name, this.#listener)
  }
}

/** A feature that keeps the kit it was configured with, as a careless one might. */
class Keeper extends FeatureBuilder {
  readonly [kFeatureName] = 'keeper'
  kit: FeatureConfigureKit | undefined

  protected override configure(kit: FeatureConfigureKit): void {
    this.kit = kit
  }
}

describe('listeners', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('serves a router bound to a listener a feature added, on that listener alone', async () => {
    app = createWebApplication()
      .server(() => ({ listener }))
      .install(new Probe('probe', l => l.server(() => ({ listener }))))
      .mount(
        newRouter('/probe')
          .extend(bindTo('probe'))
          .get('/', () => ({ up: true })),
      ) as WebApplication

    await app.run()

    const probe = app.listeners.get('probe')!
    expect(await (await fetch(`${probe.address!.origin}/probe`)).json()).toEqual({ up: true })
    expect((await fetch(`${app.address!.origin}/probe`)).status).toBe(404)
  })

  it('hands the callback the resolved configuration, so a port read from it is the one listened on', async () => {
    const schema = $t.Object({ admin: $t.Object({ host: $t.String(), port: $t.Number() }) })
    // A fixed port, where the application's own listener takes whatever port the system gives it.
    const port = await freePort()
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ admin: { host: '127.0.0.1', port } }))
      .build().config
    app = createWebApplication({ config: conf })
      .server(() => ({ listener }))
      .listener('admin', (l, { config }) => l.server(() => ({ listener: config.admin }))) as WebApplication

    await app.run()

    expect(app.listeners.get('admin')!.address!.port).toBe(port)
  })

  it('keeps the order listeners were added in, the application before the features it configures', async () => {
    app = createWebApplication().install(new Probe('probe')).listener('admin').listener('metrics') as WebApplication

    await app.bootstrap()

    expect([...app.listeners.keys()]).toEqual(['admin', 'metrics', 'probe'])
  })

  it('refuses a name a feature takes after the application took it, when the application starts', async () => {
    app = createWebApplication().listener('admin').install(new Probe('admin')) as WebApplication

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_CONFIGURATION',
      message: expect.stringMatching(/^Cannot add listener "admin": a listener named "admin" is already added/),
    })
  })

  it('refuses a listener added once the application has started: nothing would build it', async () => {
    app = createWebApplication()
    await app.bootstrap()

    expect(() => app!.listener('late')).toThrow(ErrApplicationStarted)
  })

  it('refuses a listener a feature adds through a kit it kept past start-up', async () => {
    const keeper = new Keeper()
    app = createWebApplication().install(keeper) as WebApplication
    await app.bootstrap()

    expect(() => listenersOf(keeper.kit!).add('late')).toThrow(ErrApplicationStarted)
  })

  it('refuses a feature adding a listener to an application that runs no server', async () => {
    const headless = createApplication().install(new Probe('probe'))

    await expect(headless.bootstrap()).rejects.toMatchObject({
      code: 'ERR_CONFIGURATION',
      message: expect.stringMatching(/^Cannot add a listener: the application is not a web application/),
    })
    await headless.close().catch(() => undefined)
  })
})
