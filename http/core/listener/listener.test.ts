import { createServer } from 'node:net'

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

import { createWebApplication } from '../../application.js'
import { bindTo, type WebApplication, Router } from '../../index.js'
import { type NodeServerSettings, node } from '../../platform/node/index.js'
import { listenersOf, type ListenerConfigurer } from './listener.js'

/**
 * Listeners are a list the application keeps: the application adds to it with `.listener(...)`, a feature with
 * `listenersOf(kit).add(...)`. A name is taken once, whoever takes it, so a router bound to it is never served by
 * the wrong server.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** A feature shipping a listener of its own, the way a metrics feature ships its port. */
class Probe<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'probe'

  readonly #name: string
  readonly #listener: ListenerConfigurer<C, NodeServerSettings> | undefined

  constructor(name: string, listener?: ListenerConfigurer<C, NodeServerSettings>) {
    super()
    this.#name = name
    this.#listener = listener
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    listenersOf<C, NodeServerSettings>(kit).add(this.#name, this.#listener)
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
    app = createWebApplication({ adapter: node() })
      .server(() => ({ listen: listener }))
      .install(new Probe('probe', l => l.server(() => ({ listen: listener }))))
      .mount(new Router('/probe').extend(bindTo('probe')).get('/', () => ({ up: true }))) as WebApplication

    await app.run()

    const probe = app.listeners.get('probe')!
    expect(await (await fetch(`${probe.address!.origin}/probe`)).json()).toEqual({ up: true })
    expect((await fetch(`${app.address!.origin}/probe`)).status).toBe(404)
  })

  it('hands the callback the resolved configuration, so a port read from it is the one listened on', async () => {
    const free = await new Promise<number>(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number }
        probe.close(() => resolve(port))
      })
    })
    const schema = $t.Object({ admin: $t.Object({ host: $t.String(), port: $t.Number() }) })
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ admin: { host: '127.0.0.1', port: free } }))
      .build().config
    app = createWebApplication({ adapter: node(), config: conf })
      .server(() => ({ listen: listener }))
      .listener('admin', (l, { config }) => l.server(() => ({ listen: config.admin }))) as WebApplication

    await app.run()

    expect(app.listeners.get('admin')!.address!.port).toBe(free)
  })

  it('keeps the order listeners were added in, the application before the features it configures', async () => {
    app = createWebApplication({ adapter: node() })
      .install(new Probe('probe'))
      .listener('admin')
      .listener('metrics') as WebApplication

    await app.bootstrap()

    expect([...app.listeners.keys()]).toEqual(['admin', 'metrics', 'probe'])
  })

  it('refuses a name a feature takes after the application took it, when the application starts', async () => {
    app = createWebApplication({ adapter: node() }).listener('admin').install(new Probe('admin')) as WebApplication

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_CONFIGURATION',
      message: expect.stringMatching(/^Cannot add listener "admin": a listener named "admin" is already added/),
    })
  })

  it('refuses a listener added once the application has started: nothing would build it', async () => {
    app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    expect(() => app!.listener('late')).toThrow(ErrApplicationStarted)
  })

  it('refuses a listener a feature adds through a kit it kept past start-up', async () => {
    const keeper = new Keeper()
    app = createWebApplication({ adapter: node() }).install(keeper) as WebApplication
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

describe('ListenerBuilder.hook', () => {
  // A listener's hooks are its own: the application's server never runs them.
  it('runs a listener hook on that listener alone', async () => {
    const app = createWebApplication({ adapter: node() })
      .listener('admin', l => l.hook('onSend', ctx => void ctx.header('x-listener', 'admin')))
      .mount(new Router('/jobs').extend(bindTo('admin')).get('/', () => 'jobs'))
      .mount(new Router('/own').get('/', () => 'own'))

    try {
      await app.bootstrap()

      expect((await app.listeners.get('admin')!.request('/jobs')).headers.get('x-listener')).toBe('admin')
      expect((await app.request('/own')).headers.get('x-listener')).toBe(null)
    } finally {
      await app.close()
    }
  })
})
