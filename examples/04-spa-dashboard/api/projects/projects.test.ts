import type { WebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CURL, NAVIGATION, XHR, expectNotFoundJSON, newApp, signIn, type Session } from '../util/testing/harness.js'

/**
 * The API, from both route sources.
 *
 * `/api/profile` and `/api/admin` are `@Controller` classes; `/api/projects` is a programmatic `newRouter`.
 * They are asserted side by side on purpose: both compile through `compileRouteGroup`, so authorization,
 * validation and error handling must be indistinguishable — and one `/api/*` catch-all has to cover all three.
 */
describe('the API', () => {
  let app: WebApplication
  let member: Session
  let admin: Session

  beforeAll(async () => {
    app = newApp()
    await app.ready()
    member = await signIn(app, 'user', 'user123')
    admin = await signIn(app, 'admin', 'admin123')
  })

  afterAll(async () => await app.close())

  describe('authorization is the same from either source', () => {
    it('gates a controller route and a router route alike, with no declaration on either', async () => {
      for (const path of ['/api/profile', '/api/projects']) {
        expect((await app.fetch(path, { headers: XHR })).status, path).toBe(401)
        expect((await app.fetch(path, { headers: { ...XHR, cookie: member.cookie } })).status, path).toBe(200)
      }
    })

    it('serves the projects router to a signed-in caller', async () => {
      const res = await app.fetch('/api/projects', { headers: { ...XHR, cookie: member.cookie } })
      const body = (await res.json()) as { projects: Array<{ id: string }> }

      expect(body.projects.map(project => project.id)).toEqual(['roast', 'grind', 'brew'])
    })

    it('routes a parameterised path on the router, and refuses an unknown id through the error pipeline', async () => {
      const found = await app.fetch('/api/projects/brew', { headers: { ...XHR, cookie: member.cookie } })
      expect(found.status).toBe(200)
      expect(await found.json()).toMatchObject({ id: 'brew', status: 'done' })

      await expectNotFoundJSON(await app.fetch('/api/projects/nope', { headers: { ...XHR, cookie: member.cookie } }))
    })
  })

  describe('roles', () => {
    it('lets an administrator through', async () => {
      const res = await app.fetch('/api/admin/users', { headers: { ...XHR, cookie: admin.cookie } })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { users: Array<{ id: string }> }
      expect(body.users.map(user => user.id)).toEqual(['admin', 'user'])
    })

    // The API half of fix F2: `forbid` answers a fetch with the status, not a redirect to the page.
    it('refuses a signed-in member with a plain 403, never a redirect', async () => {
      const res = await app.fetch('/api/admin/users', { headers: { ...XHR, cookie: member.cookie } })

      expect(res.status).toBe(403)
      expect(res.headers.get('location')).toBeNull()
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    it('never leaks the directory to an anonymous caller', async () => {
      expect((await app.fetch('/api/admin/users', { headers: XHR })).status).toBe(401)
    })
  })

  // One line in `spa/pages.ts` covers a router base and two controller bases — and every future one.
  describe('the API owns its own misses', () => {
    it('answers an unknown API path with the JSON envelope, for a navigation as much as for a fetch', async () => {
      for (const path of ['/api/typo', '/api/projects/brew/deep', '/api/profile/extra']) {
        await expectNotFoundJSON(await app.fetch(path, { headers: { ...NAVIGATION, cookie: member.cookie } }))
        await expectNotFoundJSON(await app.fetch(path, { headers: { ...XHR, cookie: member.cookie } }))
      }
    })

    // Without the catch-all these would fall through to the client-route wildcard and be handed the shell.
    it('never hands a browser the application in place of an API answer', async () => {
      const res = await app.fetch('/api/typo', { headers: { ...NAVIGATION, cookie: member.cookie } })

      expect(await res.text()).not.toContain('<div id="root">')
    })

    it('keeps a miss gated, so an anonymous caller learns nothing about what exists', async () => {
      expect((await app.fetch('/api/typo', { headers: XHR })).status).toBe(401)
    })
  })

  describe('health probes coexist with a root catch-all', () => {
    it('answers liveness without a session, and not with the shell', async () => {
      const res = await app.fetch('/livez', { headers: CURL })

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    })

    // The probes are raw routes marked exempt, so the gate returns before authenticating at all — which is the
    // point for something polled every second. They are never challenged, whatever they answer.
    it('never challenges a probe', async () => {
      for (const path of ['/livez', '/readyz', '/startupz']) {
        const res = await app.fetch(path, { headers: CURL })
        expect([401, 403], path).not.toContain(res.status)
      }
    })
  })
})
