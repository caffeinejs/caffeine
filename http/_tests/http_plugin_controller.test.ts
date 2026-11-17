import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import {
  Controller,
  Get,
  HTTPPlugin,
  type HTTPSetupContext,
  type MiddlewareFn,
  Prefix,
  Use,
  type WebApplication,
} from '../index.js'
import { node } from '../platform/node/index.js'

/**
 * Scenario: a controller's `@Use(...)` taking an `HTTPPlugin`. Its middleware runs in front of the controller's
 * routes, a path relative to the controller. In a file of its own: every application built here picks up these
 * classes.
 */

function stamp(header: string): MiddlewareFn {
  return (ctx, next) => {
    ctx.header(header, 'yes')
    next()
  }
}

class Marking extends HTTPPlugin {
  override readonly name: string

  constructor(
    private readonly header: string,
    private readonly value = 'yes',
  ) {
    super()
    this.name = `marking:${header}`
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onRequest', ctx => void ctx.header(this.header, this.value))
  }
}

class Stamping extends HTTPPlugin {
  register({ app }: HTTPSetupContext): void {
    app.use(stamp('x-all'))
    app.use('/sub', stamp('x-sub'))
  }
}

@Use(() => new Marking('x-marking'))
@Use(() => new Stamping())
@Controller('/ctl')
class StampedController {
  @Get('/sub')
  sub() {
    return {}
  }

  @Get('/other')
  other() {
    return {}
  }
}

@Use(() => new Stamping())
@Prefix('/v1')
@Controller('/prefixed')
class PrefixedController {
  @Get('/sub')
  sub() {
    return {}
  }
}

@Controller('/plain')
class PlainController {
  @Get('/')
  get() {
    return {}
  }
}

void [StampedController, PrefixedController, PlainController]

describe('HTTPPlugin on a controller', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it("runs its middleware in front of the controller's routes alone, a path relative to the controller", async () => {
    app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    const sub = await app.request('/ctl/sub')
    expect(sub.headers.get('x-all')).toBe('yes')
    expect(sub.headers.get('x-sub')).toBe('yes')
    // A second plugin on the same controller still installs, ahead of the middleware.
    expect(sub.headers.get('x-marking')).toBe('yes')

    const other = await app.request('/ctl/other')
    expect(other.headers.get('x-all')).toBe('yes')
    expect(other.headers.get('x-sub')).toBeNull()

    expect((await app.request('/plain')).headers.get('x-all')).toBeNull()
  })

  it("starts a relative path at the controller's prefix", async () => {
    app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    expect((await app.request('/v1/prefixed/sub')).headers.get('x-sub')).toBe('yes')
  })
})
