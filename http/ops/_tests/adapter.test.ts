import { CaffeineIoC } from '@caffeinejs/di'
import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'

import type { Adapter, AdapterIn, AdapterServer, HTTPSetupContext } from '../../adapter.js'
import { createWebApplication } from '../../application.js'
import type { FastifyTypes } from '../../fastify_adapter.js'
import { Ops } from '../../index.js'
import { pluginName, type AnyFastifyPlugin } from '../../plugin.js'

/**
 * An ops server goes through the adapter call the application's own server goes through, with an input of its own:
 * the framework's head slots, then its own plugins; its own middleware and settings; and none of what only the
 * application's own server takes.
 */

/** Records what every server is set up with, and builds none: the contract is all this file needs. */
class RecordingAdapter implements Adapter<FastifyTypes> {
  /** In call order: the application's own server first. */
  readonly inputs: AdapterIn<FastifyTypes>[] = []

  async setup(input: AdapterIn<FastifyTypes>): Promise<AdapterServer<FastifyTypes>> {
    this.inputs.push(input)
    return new IdleServer()
  }
}

/** What {@link RecordingAdapter} hands back: nothing was built, so it never listens and answers nothing. */
class IdleServer implements AdapterServer<FastifyTypes> {
  get instance(): never {
    throw new Error('No server was built')
  }

  get address(): undefined {
    return undefined
  }

  run(): Promise<void> {
    return Promise.resolve()
  }

  fetch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 501 }))
  }

  teardown(): Promise<void> {
    return Promise.resolve()
  }
}

const named = (name: string) => () => fp(async () => undefined, { name })

describe('an ops server, as its adapter is handed it', () => {
  it('is set up from its own plugins, middleware, settings and context, and from nothing only the application takes', async () => {
    const adapter = new RecordingAdapter()
    const seen: HTTPSetupContext[] = []

    const app = createWebApplication(() => adapter, { container: new CaffeineIoC({ decorators: false }) })
      .install(
        Ops('admin', o =>
          o
            .server(context => {
              seen.push(context)
              return { listener: { port: 9464 } }
            })
            .with(context => {
              seen.push(context)
              return named('first')()
            })
            .with(named('second'))
            .use((_ctx, next) => next(), { hook: 'preHandler' }),
        ),
      )
      .with(named('own'))
      .basePath('/api')
      .serverCallback(() => undefined)
      .use((_ctx, next) => next(), { hook: 'onSend' })

    await app.bootstrap()

    const names = (input: AdapterIn<FastifyTypes>) =>
      input.extensions.root().map(entry => pluginName(entry as AnyFastifyPlugin))
    const [own, ops] = adapter.inputs

    expect(adapter.inputs).toHaveLength(2)
    expect(names(own)).toEqual(['caffeine-error-handling', 'caffeine-cookie', 'own'])
    expect(names(ops)).toEqual(['caffeine-error-handling', 'caffeine-cookie', 'first', 'second'])

    expect(own.middlewares.resolve(own.context).map(middleware => middleware.hook)).toEqual(['onSend'])
    expect(ops.middlewares.resolve(ops.context).map(middleware => middleware.hook)).toEqual(['preHandler'])

    expect(ops.server).toEqual({ listener: { port: 9464 } })
    expect(own.basePath).toBe('/api')
    expect(ops.basePath).toBeUndefined()
    expect(own.customize).toBeDefined()
    expect(ops.customize).toBeUndefined()

    // Its settings and its plugins are built from the context the server itself is set up with.
    expect(ops.context).not.toBe(own.context)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(ops.context)
    expect(seen[1]).toBe(ops.context)

    await app.close()
  })
})
