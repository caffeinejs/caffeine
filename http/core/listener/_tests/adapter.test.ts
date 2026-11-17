import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import type { IAdapter, AdapterIn, IAdapterServer, HTTPSetupContext } from '../../../adapter.js'
import { WebApplication } from '../../../application.js'
import { HTTPPlugin } from '../../../index.js'
import type { NodeAdapterTypes } from '../../../platform/node/index.js'
import type { HookBatch } from '../../lifecycle/batch.js'

/**
 * A listener goes through the adapter call the application's own server goes through, with an input of its own:
 * its own plugins, middleware and settings, and none of what only the application's own server takes. The
 * framework's head slots are the adapter's to install, so neither input carries them.
 */

/** Records what every server is set up with, and builds none: the contract is all this file needs. */
class RecordingAdapter implements IAdapter<NodeAdapterTypes> {
  /** In call order: the application's own server first. */
  readonly inputs: AdapterIn<NodeAdapterTypes>[] = []

  async setup(input: AdapterIn<NodeAdapterTypes>): Promise<IAdapterServer<NodeAdapterTypes>> {
    this.inputs.push(input)
    return new IdleServer()
  }
}

/** What {@link RecordingAdapter} hands back: nothing was built, so it never listens and answers nothing. */
class IdleServer implements IAdapterServer<NodeAdapterTypes> {
  get instance(): never {
    throw new Error('No server was built')
  }

  get address(): undefined {
    return undefined
  }

  run(): Promise<void> {
    return Promise.resolve()
  }

  request(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 501 }))
  }

  fetch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 501 }))
  }

  teardown(): Promise<void> {
    return Promise.resolve()
  }
}

// A plugin that adds no hook leaves an empty batch, which the server does not record: each one hooks something.
const named = (name: string) => () =>
  new (class extends HTTPPlugin {
    override readonly name = name

    register({ app }: HTTPSetupContext): void {
      app.hook('onRequest', () => undefined)
    }
  })()

describe('a listener, as its adapter is handed it', () => {
  it('is set up from its own plugins, middleware, settings and context, and from nothing only the application takes', async () => {
    const adapter = new RecordingAdapter()
    const seen: HTTPSetupContext[] = []

    const app = new WebApplication(() => adapter, { container: new CaffeineIoC({ decorators: false }) })
      .listener('admin', l =>
        l
          .server(context => {
            seen.push(context)
            return { listen: { port: 9464 } }
          })
          .with(context => {
            seen.push(context)
            return named('first')()
          })
          .with(named('second'))
          .use((_ctx, next) => next(), { hook: 'preHandler' }),
      )
      .with(named('own'))
      .basePath('/api')
      .serverCallback(() => undefined)
      .use((_ctx, next) => next(), { hook: 'onSend' })

    await app.bootstrap()

    const names = (input: AdapterIn<NodeAdapterTypes>) =>
      input.extensions.root().map(entry => (entry as HookBatch).name)
    const [own, admin] = adapter.inputs

    expect(adapter.inputs).toHaveLength(2)
    expect(names(own)).toEqual(['own'])
    expect(names(admin)).toEqual(['first', 'second'])

    expect(own.middlewares.resolve(own.context).map(middleware => middleware.hook)).toEqual(['onSend'])
    expect(admin.middlewares.resolve(admin.context).map(middleware => middleware.hook)).toEqual(['preHandler'])

    expect(admin.server).toEqual({ listen: { port: 9464 } })
    expect(own.basePath).toBe('/api')
    expect(admin.basePath).toBeUndefined()
    expect(own.customize).toBeDefined()
    expect(admin.customize).toBeUndefined()

    // Its settings and its plugins are built from the context the server itself is set up with.
    expect(admin.context).not.toBe(own.context)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(admin.context)
    expect(seen[1]).toBe(admin.context)

    await app.close()
  })
})
