import { CaffeineIoC, type Ctor } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import type { IContext } from '../../context.js'
import { Controller } from '../../decorators/controller.js'
import { OnRequest, OnSend } from '../../decorators/hooks.js'
import { Get } from '../../decorators/verbs.js'
import { createWebApplication } from '../../platform/fastify/index.js'
import { Keys } from '../../symbols.js'
import { ErrConfiguration } from '../error/common.js'

type App = ReturnType<typeof createWebApplication>
let app: App | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

/** The fetch application serving `controller` alone, whatever else this file decorated. */
function application(controller: Ctor): App {
  const container = new CaffeineIoC({ decorators: false })
  container.bind(controller, t => t.toSelf().labels(Keys.CONTROLLER))
  app = createWebApplication({ container })
  return app
}

describe('a controller with hook methods', () => {
  it('refuses a method that is both a route and a hook', async () => {
    @Controller('/both')
    class Both {
      @OnRequest()
      @Get('/')
      get() {
        return 'ok'
      }
    }

    const booting = application(Both).bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow('Method "get" in "Both" cannot be both a route and a hook')
  })

  // The hook would never run: the method is no route, and the decorator names only that method.
  it('refuses a hook decorator on a method that is no route', async () => {
    @Controller('/verbless')
    class Verbless {
      @OnRequest(() => undefined)
      helper() {
        return 'nothing'
      }
    }

    await expect(application(Verbless).bootstrap()).rejects.toThrow(
      'Method "helper" in "Verbless" has a hook decorator but is no route',
    )
  })

  // A hook ahead of the controller's answered, so no controller was resolved for the request: its hook method has
  // nothing to run on, and is skipped rather than failing the answer.
  it('skips a hook method when an earlier hook answered before the controller was reached', async () => {
    @Controller('/early')
    class Early {
      @Get('/')
      get() {
        return 'handler'
      }

      @OnSend()
      stamp(ctx: IContext) {
        ctx.header('x-stamped', 'yes')
      }
    }

    const a = application(Early).hook('onRequest', ctx => {
      ctx.body('early')
    })
    await a.bootstrap()

    const res = await a.request('/early')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('early')
    expect(res.headers.get('x-stamped')).toBe(null)
  })
})
