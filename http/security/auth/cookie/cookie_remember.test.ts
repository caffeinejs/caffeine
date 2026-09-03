import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import type { CredentialUser } from '../credentials/index.js'
import { UserProvider } from '../credentials/index.js'
import { AuthenticationTicket } from '../ticket.js'
import { parseRemember } from './_remember.js'
import { CookieAuthenticationHandler } from './cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie_options.js'
import { RememberMeTokenStore, type RememberMeRecord, type RememberMeRotation } from './remember_me_token_store.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'

class FakeStore extends RememberMeTokenStore {
  readonly map = new Map<string, RememberMeRecord>()
  create = vi.fn((r: RememberMeRecord) => {
    this.map.set(r.series, { ...r })
  })
  findBySeries = vi.fn((s: string) => this.map.get(s) ?? null)
  updateToken = vi.fn((s: string, rotation: RememberMeRotation) => {
    const r = this.map.get(s)
    if (r) {
      r.tokenHash = rotation.tokenHash
      r.previousTokenHash = rotation.previousTokenHash
      r.rotatedAt = rotation.rotatedAt
      r.expiresAt = rotation.expiresAt
    }
  })

  remove = vi.fn((s: string) => {
    this.map.delete(s)
  })
  removeBySubject = vi.fn((sub: string) => {
    for (const [k, v] of this.map) {
      if (v.subject === sub) {
        this.map.delete(k)
      }
    }
  })
}

class FakeUserProvider extends UserProvider {
  findByIdentifier = vi.fn()
  findById = vi.fn((id: string): CredentialUser | null =>
    id === 'u1' ? { id: 'u1', passwordHash: 'x', claims: [new Claim('roles', 'admin', '')] } : null,
  )
}

function makeCtx(initial: Record<string, string> = {}) {
  const jar: Record<string, string> = { ...initial }
  const setCookie = vi.fn((name: string, value: string) => {
    jar[name] = value
  })
  const deleteCookie = vi.fn((name: string) => {
    delete jar[name]
  })
  const status = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const ctx = {
    req: { cookie: (name: string) => jar[name] },
    cookie: setCookie,
    deleteCookie,
    status,
    header,
  } as unknown as Context
  return { ctx, jar, setCookie, deleteCookie }
}

function makeHandler() {
  const store = new FakeStore()
  const userProvider = new FakeUserProvider()
  const options = new CookieAuthenticationOptionsBuilder().sessionSecret(SECRET).rememberMe().build()
  const handler = new CookieAuthenticationHandler('Cookie', options)
  handler.setRememberDeps({ get: () => store }, { get: () => userProvider })
  return { handler, store, userProvider }
}

function principal(): Principal {
  return new Principal(true, new Identity('Cookie', true, [new Claim('sub', 'u1', '')]))
}

const REMEMBER = 'caf.remember'
const SESSION = 'caf.session'

describe('CookieAuthenticationHandler — durable remember-me', () => {
  it('persist(rememberMe:true) creates a store record and sets a persistent remember cookie', async () => {
    const { handler, store } = makeHandler()
    const { ctx, jar } = makeCtx()

    await handler.persist(ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))

    expect(store.create).toHaveBeenCalledOnce()
    expect(store.create.mock.calls[0][0].subject).toBe('u1')
    expect(jar[REMEMBER]).toBeDefined()
    expect(jar[SESSION]).toBeDefined()
    // remember cookie value maps to the stored series
    expect(store.map.has(parseRemember(jar[REMEMBER])!.series)).toBe(true)
  })

  it('persist(rememberMe:false) sets only a session cookie, no remember record', async () => {
    const { handler, store } = makeHandler()
    const { ctx, jar } = makeCtx()

    await handler.persist(ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: false }))

    expect(store.create).not.toHaveBeenCalled()
    expect(jar[REMEMBER]).toBeUndefined()
    expect(jar[SESSION]).toBeDefined()
  })

  it('a valid session cookie short-circuits: the remember store is never touched', async () => {
    const { handler, store } = makeHandler()
    const { ctx, jar } = makeCtx()
    await handler.persist(ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: false }))

    const result = await handler.authenticate(makeCtx({ [SESSION]: jar[SESSION] }).ctx)
    expect(result.succeeded).toBe(true)
    expect(store.findBySeries).not.toHaveBeenCalled()
  })

  it('refreshes from the remember cookie: reloads the user, rotates the token, reissues both cookies', async () => {
    const { handler, store, userProvider } = makeHandler()

    // Sign in with remember-me, then drop the session cookie to force the remember path.
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))
    const rememberBefore = signIn.jar[REMEMBER]
    const seriesBefore = parseRemember(rememberBefore)!

    const { ctx, jar } = makeCtx({ [REMEMBER]: rememberBefore })
    const result = await handler.authenticate(ctx)

    expect(result.succeeded).toBe(true)
    expect(result.ticket!.principal.findFirst('sub')?.value).toBe('u1')
    expect(result.ticket!.principal.isInRole('admin')).toBe(true) // reloaded via findById
    expect(userProvider.findById).toHaveBeenCalledWith('u1')
    expect(store.updateToken).toHaveBeenCalledOnce()
    // rotated: new remember cookie, same series, different token
    const rememberAfter = jar[REMEMBER]
    expect(rememberAfter).toBeDefined()
    expect(rememberAfter).not.toBe(rememberBefore)
    expect(parseRemember(rememberAfter!)!.series).toBe(seriesBefore.series)
    // a fresh session cookie was established
    expect(jar[SESSION]).toBeDefined()
  })

  it('detects token theft: known series with a wrong token removes the series and fails', async () => {
    const { handler, store } = makeHandler()
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))
    const series = parseRemember(signIn.jar[REMEMBER])!.series

    const { ctx, jar } = makeCtx({ [REMEMBER]: `${series}:forged-token` })
    const result = await handler.authenticate(ctx)

    expect(result.succeeded).toBe(false)
    expect(store.remove).toHaveBeenCalledWith(series)
    expect(store.map.has(series)).toBe(false)
    expect(jar[REMEMBER]).toBeUndefined() // cleared
  })

  it('rejects an expired remember record and removes it', async () => {
    const { handler, store } = makeHandler()
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))
    const remember = signIn.jar[REMEMBER]
    const series = parseRemember(remember)!.series
    store.map.get(series)!.expiresAt = Math.floor(Date.now() / 1000) - 10 // expire it

    const result = await handler.authenticate(makeCtx({ [REMEMBER]: remember }).ctx)
    expect(result.succeeded).toBe(false)
    expect(store.remove).toHaveBeenCalledWith(series)
  })

  it('returns none for an unknown series', async () => {
    const { handler } = makeHandler()
    const result = await handler.authenticate(makeCtx({ [REMEMBER]: 'ghost:token' }).ctx)
    expect(result.succeeded).toBe(false)
  })

  it('revoke removes the series server-side and clears both cookies', async () => {
    const { handler, store } = makeHandler()
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))
    const series = parseRemember(signIn.jar[REMEMBER])!.series

    const { ctx, deleteCookie } = makeCtx({ [SESSION]: signIn.jar[SESSION], [REMEMBER]: signIn.jar[REMEMBER] })
    await handler.revoke(ctx)

    expect(store.remove).toHaveBeenCalledWith(series)
    expect(deleteCookie).toHaveBeenCalledWith(SESSION, { path: '/' })
    expect(deleteCookie).toHaveBeenCalledWith(REMEMBER, { path: '/' })
  })
})
