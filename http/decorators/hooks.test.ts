import { CaffeineIoC, ErrInvalidDecorator, type Ctor } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../application.js'
import type { IContext } from '../context.js'
import { node, type NodeAdapter } from '../platform/node/index.js'
import { Keys } from '../symbols.js'
import { Controller } from './controller.js'
import { OnRequest, OnSend } from './hooks.js'
import { Get } from './verbs.js'

type App = WebApplication<never, never, unknown, NodeAdapter>
let app: App | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** The fetch application serving `controller` alone, whatever else this file decorated. */
async function serve(controller: Ctor): Promise<App> {
  const container = new CaffeineIoC({ decorators: false })
  container.bind(controller, t => t.toSelf().labels(Keys.CONTROLLER))
  app = createWebApplication({ adapter: node(), container })
  await app.bootstrap()
  return app
}

describe('hook decorators', () => {
  it('runs a class-level hook for every route of the controller, in the order written', async () => {
    @OnRequest(ctx => void ctx.appendHeader('x-order', 'first'))
    @OnRequest(ctx => void ctx.appendHeader('x-order', 'second'))
    @Controller('/class')
    class ClassHooks {
      @Get('/a')
      a() {
        return 'a'
      }

      @Get('/b')
      b() {
        return 'b'
      }
    }

    const a = await serve(ClassHooks)

    expect((await a.request('/class/a')).headers.get('x-order')).toBe('first, second')
    expect((await a.request('/class/b')).headers.get('x-order')).toBe('first, second')
  })

  // The method form runs on the controller, so it reaches what the controller was built with.
  it('runs a hook method with this the controller', async () => {
    @Controller('/method')
    class MethodHooks {
      readonly tag = 'from-controller'

      @Get('/')
      get() {
        return 'ok'
      }

      @OnSend()
      stamp(ctx: IContext) {
        ctx.header('x-tag', this.tag)
      }
    }

    const res = await (await serve(MethodHooks)).request('/method')

    expect(res.headers.get('x-tag')).toBe('from-controller')
  })

  it('runs a route-level hook on that route alone, after the class-level one', async () => {
    @OnRequest(ctx => void ctx.appendHeader('x-order', 'class'))
    @Controller('/route')
    class RouteHooks {
      @OnRequest(ctx => void ctx.appendHeader('x-order', 'route'))
      @Get('/a')
      a() {
        return 'a'
      }

      @Get('/b')
      b() {
        return 'b'
      }
    }

    const a = await serve(RouteHooks)

    expect((await a.request('/route/a')).headers.get('x-order')).toBe('class, route')
    expect((await a.request('/route/b')).headers.get('x-order')).toBe('class')
  })

  // `@OnRequest()` on a class names no hook to run: refused where it is written, for a caller the types did not stop.
  it('refuses the method form on a class', () => {
    expect(() => {
      // @ts-expect-error -- the method form takes a method
      @OnRequest()
      class Nothing {}
      void Nothing
    }).toThrow(ErrInvalidDecorator)
  })
})
