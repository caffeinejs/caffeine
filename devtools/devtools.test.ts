import { DevTool, ErrDevToolInvalid, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  Identity,
  Principal,
  type IContext,
  type WebApplication,
} from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DevTools, devTools, type DevToolsBuilder } from './devtools.js'

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
  ]
}

describe('devtools', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    await app?.close().catch(() => undefined)
    app = undefined
  })

  function devtoolsServer(): { fetch: (path: string, init?: RequestInit) => Promise<Response> } {
    return app!.listeners.get('devtools')!
  }

  describe('DevTools()', () => {
    it('serves the devtools on a server of their own, and not on the one the application serves its users on', async () => {
      app = createWebApplication().install(DevTools()) as WebApplication
      await app.bootstrap()

      expect((await devtoolsServer().fetch('/devtools')).status).toBe(200)
      expect((await app.fetch('/devtools')).status).toBe(404)
    })

    it('lists every core tool with links to its resources, and answers with no-store', async () => {
      app = createWebApplication().install(DevTools()) as WebApplication
      await app.bootstrap()

      const res = await devtoolsServer().fetch('/devtools')
      const { tools } = (await res.json()) as { tools: Array<{ id: string; links: Array<{ href: string }> }> }

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

    it('serves under the path it is given', async () => {
      app = createWebApplication().install(DevTools(d => d.path('/_admin/devtools'))) as WebApplication
      await app.bootstrap()

      expect((await devtoolsServer().fetch('/_admin/devtools/info')).status).toBe(200)
      expect((await devtoolsServer().fetch('/devtools/info')).status).toBe(404)
    })

    it('requires what authorize(...) names, authenticating on its own server', async () => {
      app = createWebApplication()
        .install(Authentication(a => a.addStrategy('Header', new HeaderScheme())))
        .install(DevTools(d => d.authorize({ roles: ['ops'] }))) as WebApplication
      await app.bootstrap()

      expect((await devtoolsServer().fetch('/devtools/info')).status).toBe(401)
      expect((await devtoolsServer().fetch('/devtools/info', { headers: { 'x-user': 'bob:dev' } })).status).toBe(403)
      expect((await devtoolsServer().fetch('/devtools/info', { headers: { 'x-user': 'ann:ops' } })).status).toBe(200)
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
      app = createWebApplication().install(DevTools(d => d.allowProduction())) as WebApplication
      await app.bootstrap()

      expect((await devtoolsServer().fetch('/devtools')).status).toBe(200)
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

    it('takes where it listens from the configuration, a fluent setter winning', async () => {
      app = createWebApplication().install(
        DevTools(d => d.config({ path: '/from-config', port: 0 }).path('/fluent')),
      ) as WebApplication
      await app.bootstrap()

      expect((await devtoolsServer().fetch('/fluent/info')).status).toBe(200)
      expect((await devtoolsServer().fetch('/from-config/info')).status).toBe(404)
    })
  })

  describe('devTools()', () => {
    it("serves the devtools on the server it is registered on, under that server's gate", async () => {
      app = createWebApplication().with(devTools()) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/devtools/info')).status).toBe(200)
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

      const { tools } = (await (await app!.fetch('/devtools')).json()) as {
        tools: Array<{ id: string; links: unknown[] }>
      }

      expect(tools.at(-1)).toEqual({
        id: 'queue',
        title: 'Job queue',
        description: 'Pending jobs',
        links: [
          { method: 'GET', href: '/devtools/queue/jobs' },
          { method: 'GET', href: '/devtools/queue/jobs/:id' },
          { method: 'POST', href: '/devtools/queue/jobs' },
          { method: 'DELETE', href: '/devtools/queue/jobs/:id' },
        ],
      })
      expect(await (await app!.fetch('/devtools/queue/jobs/7')).json()).toEqual({ id: '7', state: 'pending' })
    })

    it('answers 404 for what a tool does not have and 400 for what it refuses', async () => {
      await boot()

      const missing = await app!.fetch('/devtools/queue/jobs/8')
      const refused = await app!.fetch('/devtools/queue/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 8 }),
      })

      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { message: string }).message).toBe('No job "8"')
      expect(refused.status).toBe(400)
    })

    it("answers with the operation's status, and 204 when it returns nothing", async () => {
      await boot()

      const created = await app!.fetch('/devtools/queue/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '8' }),
      })
      const deleted = await app!.fetch('/devtools/queue/jobs/7', { method: 'DELETE' })

      expect(created.status).toBe(201)
      expect(deleted.status).toBe(204)
      expect((await app!.fetch('/devtools/queue/jobs/7')).status).toBe(404)
    })

    it('refuses a change sent as anything but JSON, which a cross-site form could send', async () => {
      await boot()

      for (const init of [
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'id=9' },
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"id":"9"}' },
        { method: 'POST' },
      ]) {
        expect((await app!.fetch('/devtools/queue/jobs', init)).status).toBe(415)
      }
      expect((await app!.fetch('/devtools/queue/jobs/9')).status).toBe(404)
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
