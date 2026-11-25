import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../../application.js'
import {
  Health,
  HTTPPlugin,
  type HTTPSetupContext,
  type IContext,
  type WebApplication,
  Router,
} from '../../../index.js'
import { node } from '../../../platform/node.testkit.js'

/**
 * A listener's own plugins and middleware: registered on its builder, `l.with(...)`, `l.use(...)` and
 * `l.useFn(...)`, they run on that server alone, and nothing the application registers on its own server reaches it.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** A plugin marking every response it covers with `header`: a value already there is kept, this one appended. */
class Marking extends HTTPPlugin {
  override readonly name: string
  readonly #header: string
  readonly #value: string

  constructor(header: string, value = 'yes') {
    super()
    this.#header = header
    this.#value = value
    this.name = `marking:${header}:${value}`
  }

  register({ server }: HTTPSetupContext): void {
    server.hook('onRequest', ctx => {
      const previous = ctx.getHeader(this.#header)
      ctx.header(this.#header, previous === undefined ? this.#value : `${String(previous)},${this.#value}`)
    })
  }
}

/** A plugin marking every response it covers with `header`. */
function marking(header: string, value = 'yes') {
  return () => new Marking(header, value)
}

/** A middleware marking every response it runs for with `header`. */
function tagging(header: string) {
  return (ctx: IContext, next: () => void) => {
    ctx.header(header, 'yes')
    next()
  }
}

const jobs = () => new Router('/jobs').get('/', () => ({ jobs: true }))

const status = () => new Router('/status').get('/', () => ({ up: true }))

const api = () => new Router('/api').get('/', () => ({ api: true }))

describe("a listener's own plugins and middleware", () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  function at(server: 'main' | 'admin', path: string): Promise<Response> {
    const origin = server === 'main' ? app!.address!.origin : app!.listeners.get('admin')!.address!.origin
    return fetch(`${origin}${path}`)
  }

  it("installs its own plugins in the order they were written, and none of the application's", async () => {
    app = createWebApplication({ adapter: node() })
      .listener('admin', l =>
        l
          .server(() => ({ listen: listener }))
          .with(marking('x-order', 'first'))
          .with(marking('x-order', 'second'))
          .mount(jobs()),
      )
      .server(() => ({ listen: listener }))
      .with(marking('x-app-plugin'))
      .mount(api()) as WebApplication

    await app.run()

    const onAdmin = await at('admin', '/jobs')
    expect(onAdmin.headers.get('x-order')).toBe('first,second')
    expect(onAdmin.headers.get('x-app-plugin')).toBeNull()

    const onMain = await at('main', '/api')
    expect(onMain.headers.get('x-app-plugin')).toBe('yes')
    expect(onMain.headers.get('x-order')).toBeNull()
  })

  it("runs its own middleware on its own requests, by path, and the application's on the application's", async () => {
    app = createWebApplication({ adapter: node() })
      .listener('admin', l =>
        l
          .server(() => ({ listen: listener }))
          .use(tagging('x-admin-middleware'))
          .use('/jobs', tagging('x-jobs-middleware'))
          .useFn(() => tagging('x-built-middleware'))
          .mount(jobs(), status()),
      )
      .server(() => ({ listen: listener }))
      .mount(api()) as WebApplication
    app.use(tagging('x-app-middleware'))

    await app.run()

    const onJobs = await at('admin', '/jobs')
    expect(onJobs.headers.get('x-admin-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-jobs-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-built-middleware')).toBe('yes')
    expect(onJobs.headers.get('x-app-middleware')).toBeNull()

    const onStatus = await at('admin', '/status')
    expect(onStatus.headers.get('x-admin-middleware')).toBe('yes')
    expect(onStatus.headers.get('x-jobs-middleware')).toBeNull()

    const onMain = await at('main', '/api')
    expect(onMain.headers.get('x-app-middleware')).toBe('yes')
    expect(onMain.headers.get('x-admin-middleware')).toBeNull()
    expect(onMain.headers.get('x-built-middleware')).toBeNull()
  })

  it('refuses a feature handed to its with(...), as the application refuses one', async () => {
    app = createWebApplication({ adapter: node() }).listener('admin', l => l.with(Health() as never)) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow(
      /^Cannot register feature "health" with "\.with\(\.\.\.\)": a feature is not a server plugin/,
    )
  })
})
