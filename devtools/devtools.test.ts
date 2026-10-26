import { request } from 'node:http'

import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { DevTool, ErrDevToolInvalid, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import { newConsoleLogger } from '@caffeinejs/application/logger/console'
import { $t } from '@caffeinejs/application/schema'
import { brewer, type BrewOptions } from '@caffeinejs/brewer'
import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  Identity,
  Listener,
  Principal,
  type IContext,
  type WebApplication,
} from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DevTools, devTools, type DevToolsBuilder, type DevToolsIndex, type DevToolsRoutes } from './devtools.js'

/**
 * The devtools describe an application to whoever reaches them, so where they are served, who may reach them and
 * whether they start at all are the contract: a test here failing is the devtools showing more than they were told
 * to, or to more people.
 */

/** Authenticates `user[:role,role]` from `x-user`. */
class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    const value = ctx.req.header('x-user')
    if (value === undefined) {
      return AuthenticateResult.none()
    }

    const [user, roles = ''] = value.split(':')
    const claims = [new Claim('sub', user, ''), ...roles.split(',').map(role => new Claim('roles', role, ''))]

    return AuthenticateResult.success(
      new AuthenticationTicket(new Principal(true, [new Identity('Header', true, claims)]), 'Header'),
    )
  }
}

/** A tool an application contributes, with a resource, a parameter, a refusal and a change. */
class QueueTool extends DevTool {
  readonly id = 'queue'
  readonly title = 'Job queue'
  readonly description = 'Pending jobs'
  readonly jobs = new Map([['7', { id: '7', state: 'pending' }]])
  readonly operations: DevToolOperation[] = [
    { method: 'GET', path: '/jobs', handle: () => [...this.jobs.values()] },
    {
      method: 'GET',
      path: '/jobs/:id',
      handle: ({ params }) => {
        const job = this.jobs.get(params.id)
        if (job === undefined) {
          throw new ErrDevToolNotFound(`No job "${params.id}"`)
        }
        return job
      },
    },
    {
      method: 'POST',
      path: '/jobs',
      status: 201,
      handle: ({ body }) => {
        const id = (body as { id?: unknown }).id
        if (typeof id !== 'string') {
          throw new ErrDevToolInvalid('Cannot add a job: "id" must be a string')
        }
        this.jobs.set(id, { id, state: 'pending' })
        return this.jobs.get(id)
      },
    },
    { method: 'DELETE', path: '/jobs/:id', handle: ({ params }) => void this.jobs.delete(params.id) },
    {
      method: 'GET',
      path: '/search',
      handle: ({ query, signal }) => ({ state: query.state ?? null, aborted: signal.aborted }),
    },
    {
      method: 'GET',
      path: '/broken',
      handle: () => {
        throw new Error('the queue is gone')
      },
    },
  ]
}

const conf = newConfiguration($t.Object({ app: $t.Object({ region: $t.String(), pool: $t.Integer() }) }))
  .source(new InlineConfigSource({ app: { region: 'eu-west-1', pool: 4 } }))
  .build().config

describe('devtools', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    await app?.close().catch(() => undefined)
    app = undefined
  })

  function devtoolsServer() {
    return app!.listeners.get('devtools')!
  }

  const loopback = { host: '127.0.0.1', port: 0 }

  /**
   * Runs an application with `DevTools(configure)` and answers a client typed by the devtools' own routes, reaching
   * them on their socket as an operator's tool would.
   */
  async function serve(
    configure: (d: DevToolsBuilder) => unknown = () => {},
    options: {
      path?: string
      listener?: string
      brew?: BrewOptions
      prepare?: (a: WebApplication) => void
      logger?: ReturnType<typeof newConsoleLogger>
    } = {},
  ) {
    app = createWebApplication({ config: conf, logger: options.logger ?? false })
      .server(() => ({ listener: loopback }))
      .install(Authentication(a => a.addStrategy('Header', new HeaderScheme())))
      .install(
        DevTools(d => {
          d.port(0)
          configure(d)
        }),
      ) as WebApplication
    options.prepare?.(app)
    await app.run()
    const server = app.listeners.get(options.listener ?? 'devtools')!

    return brewer<DevToolsRoutes>(`${server.address!.origin}${options.path ?? '/devtools'}`, options.brew)
  }

  /** The status a request to the devtools answers under `host`, which `fetch` would not let a test set. */
  function statusFor(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/devtools/info', headers: { host } }, res => {
        res.resume()
        resolve(res.statusCode!)
      })
        .on('error', reject)
        .end()
    })
  }

  describe('DevTools()', () => {
    it('serves the devtools on a server of their own, and not on the one the application serves its users on', async () => {
      const devtools = await serve()

      expect((await devtools.get()).status).toBe(200)
      expect((await app!.request('/devtools')).status).toBe(404)
    })

    it('lists every core tool with links to its resources, and answers with no-store', async () => {
      const devtools = await serve()

      const res = await devtools.get()
      const { tools } = await res.json()

      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(tools.map(tool => tool.id)).toEqual([
        'info',
        'health',
        'di',
        'config',
        'routes',
        'refreshables',
        'events',
        'runtime',
      ])
      expect(tools.find(tool => tool.id === 'di')!.links.map(link => link.href)).toEqual([
        '/devtools/di/bindings',
        '/devtools/di/bindings/:id',
        '/devtools/di/graph',
      ])
    })

    it("refuses a loopback request under another site's name, which DNS rebinding would send", async () => {
      app = createWebApplication()
        .server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
        .install(DevTools(d => d.port(0))) as WebApplication
      await app.run()
      const { port } = new URL(devtoolsServer().address!.origin)

      expect(await statusFor(Number(port), 'evil.example')).toBe(421)
      expect(await statusFor(Number(port), `evil.example:${port}`)).toBe(421)
      expect(await statusFor(Number(port), `127.0.0.1:${port}`)).toBe(200)
      expect(await statusFor(Number(port), `localhost:${port}`)).toBe(200)
      // A name no URL can hold is no loopback name either.
      expect(await statusFor(Number(port), '[')).toBe(421)
    })

    it('warns at start-up when it listens beyond this machine with nothing required of a caller', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        await serve(d => d.host('0.0.0.0'), { logger: newConsoleLogger({ level: 'warn' }) })

        expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(
          expect.stringContaining('Devtools answer anyone who reaches this address'),
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('shows configuration values once told to, masking what redact(...) names', async () => {
      const devtools = await serve(d => d.showConfigValues().redact('app.region'))

      const listed = await (await devtools.config.properties.get()).json()

      expect(listed.filter(property => property.path.startsWith('app.'))).toEqual([
        { path: 'app.region', origin: 'inline', secret: true, value: '******' },
        { path: 'app.pool', origin: 'inline', secret: false, value: 4 },
      ])
    })

    it('serves under the path it is given', async () => {
      const devtools = await serve(d => d.path('/_admin/devtools'), { path: '/_admin/devtools' })

      expect((await devtools.info.get()).status).toBe(200)
      expect((await devtoolsServer().request('/devtools/info')).status).toBe(404)
    })

    it('requires what authorize(...) names, authenticating on its own server', async () => {
      const devtools = await serve(d => d.authorize({ roles: ['ops'] }))
      const as = (user: string) => ({ headers: { 'x-user': user } })

      expect((await devtools.info.get()).status).toBe(401)
      expect((await devtools.info.get(as('bob:dev'))).status).toBe(403)
      expect((await devtools.info.get(as('ann:ops'))).status).toBe(200)
    })

    it('refuses authorize(...) without authentication installed, rather than serve the devtools unprotected', async () => {
      app = createWebApplication().install(DevTools(d => d.authorize({ roles: ['ops'] }))) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_FEATURE_NOT_INSTALLED' })
    })

    it('refuses to start where NODE_ENV is production, naming the way out', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      app = createWebApplication().install(DevTools()) as WebApplication

      const err = await app.bootstrap().catch((e: unknown) => e)

      expect(err).toMatchObject({ code: 'ERR_DEVTOOLS_IN_PRODUCTION' })
      expect((err as Error).message).toMatch(/^Cannot install devtools: NODE_ENV is "production"/)
      expect((err as Error).message).toContain('allowProduction()')
    })

    it('starts in production once told to', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const devtools = await serve(d => d.allowProduction())

      expect((await devtools.get()).status).toBe(200)
    })

    it.each<[string, (d: DevToolsBuilder) => unknown]>([
      ['a path without a leading slash', d => d.path('devtools')],
      ['the root path', d => d.path('/')],
      ['a port out of range', d => d.port(70_000)],
      ['an empty host', d => d.host(' ')],
    ])('refuses %s', async (_, configure) => {
      app = createWebApplication().install(DevTools(d => void configure(d))) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_DEVTOOLS_CONFIGURATION' })
    })

    it('takes the name it is given, beside a listener of the application already named devtools', async () => {
      const devtools = await serve(d => d.listener('ops'), {
        listener: 'ops',
        prepare: a => a.install(Listener('devtools', l => l.server(() => ({ listener: loopback })))),
      })

      expect((await devtools.info.get()).status).toBe(200)
      expect((await devtoolsServer().request('/devtools/info')).status).toBe(404)
    })

    it('takes where it listens from the configuration, a fluent setter winning', async () => {
      const devtools = await serve(d => d.config({ path: '/from-config', port: 0 }).path('/fluent'), {
        path: '/fluent',
      })

      expect((await devtools.info.get()).status).toBe(200)
      expect((await devtoolsServer().request('/from-config/info')).status).toBe(404)
    })
  })

  describe('devTools()', () => {
    it("serves the devtools on the server it is registered on, under that server's gate", async () => {
      app = createWebApplication({ logger: false })
        .server(() => ({ listener: loopback }))
        .with(devTools()) as WebApplication
      await app.run()
      const devtools = brewer<DevToolsRoutes>(`${app.address!.origin}/devtools`)

      const res = await devtools.info.get()

      expect(res.status).toBe(200)
      expect((await res.json()).runtime.pid).toBe(process.pid)
    })

    it('takes what to show and mask, as DevTools() does', async () => {
      app = createWebApplication({ config: conf, logger: false })
        .server(() => ({ listener: loopback }))
        .with(devTools(d => d.showConfigValues().redact('app.pool'))) as WebApplication
      await app.run()
      const devtools = brewer<DevToolsRoutes>(`${app.address!.origin}/devtools`)

      const listed = await (await devtools.config.properties.get()).json()

      expect(listed.find(property => property.path === 'app.region')?.value).toBe('eu-west-1')
      expect(listed.find(property => property.path === 'app.pool')?.value).toBe('******')
    })

    it('refuses to start where NODE_ENV is production, pointing at a server of their own', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      app = createWebApplication().with(devTools()) as WebApplication

      const err = await app.bootstrap().catch((e: unknown) => e)

      expect(err).toMatchObject({ code: 'ERR_DEVTOOLS_IN_PRODUCTION' })
      expect((err as Error).message).toContain('.install(DevTools())')
    })
  })

  describe('a contributed tool', () => {
    async function boot(): Promise<void> {
      app = createWebApplication().with(devTools()) as WebApplication
      app.container.bind(QueueTool, t => t.toSelf().extends(DevTool))
      await app.bootstrap()
    }

    it('is listed with its resources and served', async () => {
      await boot()

      const { tools } = (await (await app!.request('/devtools')).json()) as DevToolsIndex

      expect(tools.at(-1)).toEqual({
        id: 'queue',
        title: 'Job queue',
        description: 'Pending jobs',
        links: [
          { method: 'GET', href: '/devtools/queue/jobs' },
          { method: 'GET', href: '/devtools/queue/jobs/:id' },
          { method: 'POST', href: '/devtools/queue/jobs' },
          { method: 'DELETE', href: '/devtools/queue/jobs/:id' },
          { method: 'GET', href: '/devtools/queue/search' },
          { method: 'GET', href: '/devtools/queue/broken' },
        ],
      })
      expect(await (await app!.request('/devtools/queue/jobs/7')).json()).toEqual({ id: '7', state: 'pending' })
    })

    it('answers 404 for what a tool does not have and 400 for what it refuses', async () => {
      await boot()

      const missing = await app!.request('/devtools/queue/jobs/8')
      const refused = await app!.request('/devtools/queue/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 8 }),
      })

      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { message: string }).message).toBe('No job "8"')
      expect(refused.status).toBe(400)
    })

    it('hands an operation its query, the first value of a repeated parameter, and the request signal', async () => {
      await boot()

      const res = await app!.request('/devtools/queue/search?state=pending&state=done')

      expect(await res.json()).toEqual({ state: 'pending', aborted: false })
    })

    it('answers 500 for what an operation throws besides a refusal, keeping the message out', async () => {
      await boot()

      const res = await app!.request('/devtools/queue/broken')

      expect(res.status).toBe(500)
      expect(await res.text()).not.toContain('the queue is gone')
    })

    it("answers with the operation's status, and 204 when it returns nothing", async () => {
      await boot()

      const created = await app!.request('/devtools/queue/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '8' }),
      })
      const deleted = await app!.request('/devtools/queue/jobs/7', { method: 'DELETE' })

      expect(created.status).toBe(201)
      expect(deleted.status).toBe(204)
      expect((await app!.request('/devtools/queue/jobs/7')).status).toBe(404)
    })

    it('refuses a change sent as anything but JSON, which a cross-site form could send', async () => {
      await boot()

      for (const init of [
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=9' },
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"id":"9"}' },
        { method: 'POST' },
      ]) {
        expect((await app!.request('/devtools/queue/jobs', init)).status).toBe(415)
      }
      expect((await app!.request('/devtools/queue/jobs/9')).status).toBe(404)
    })

    it.each([
      ['an id that is not lower-case letters, digits and dashes', { id: 'Queue' }],
      ['an id a core tool has', { id: 'routes' }],
      ['a malformed path', { path: 'jobs' }],
      ['two operations on one method and path', { duplicate: true }],
    ])('refuses %s', async (_, change: { id?: string; path?: string; duplicate?: boolean }) => {
      class Broken extends DevTool {
        readonly id = change.id ?? 'broken'
        readonly title = 'Broken'
        readonly description = ''
        readonly operations: DevToolOperation[] = [
          { method: 'GET', path: change.path ?? '/a/:id', handle: () => 1 },
          ...(change.duplicate === true ? [{ method: 'GET' as const, path: '/a/:key', handle: () => 2 }] : []),
        ]
      }

      app = createWebApplication().with(devTools()) as WebApplication
      app.container.bind(Broken, t => t.toSelf().extends(DevTool))

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_DEVTOOLS_CONFIGURATION' })
    })
  })
})
