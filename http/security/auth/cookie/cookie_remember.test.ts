import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import type { CredentialUser } from '../credentials/index.js'
import { UserProvider } from '../credentials/index.js'
import { parseToken, type SeriesTokenRecord, type SeriesTokenRotation } from '../internal/series_token.js'
import { AuthenticationTicket } from '../ticket.js'
import { CookieAuthenticationHandler, REMEMBERED_CLAIM } from './cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie_options.js'
import { RememberMeTokenStore } from './remember_me_token_store.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'

class FakeStore extends RememberMeTokenStore {
  readonly map = new Map<string, SeriesTokenRecord>()
  create = vi.fn((r: SeriesTokenRecord) => {
    this.map.set(r.series, { ...r })
  })
  findBySeries = vi.fn((s: string) => {
    const r = this.map.get(s)
    return r === undefined ? null : { ...r }
  })
  // The swap the contract asks for: only while the token is still the one that was read.
  rotate = vi.fn((s: string, expectedTokenHash: string, rotation: SeriesTokenRotation) => {
    const r = this.map.get(s)
    if (r === undefined || r.tokenHash !== expectedTokenHash) {
      return false
    }

    Object.assign(r, rotation)
    return true
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
  override findById = vi.fn((id: string): CredentialUser | null =>
    id === 'u1' ? { id: 'u1', passwordHash: 'x', claims: [new Claim('roles', 'admin', '')] } : null,
  )
}

function makeCtx(initial: Record<string, string> = {}, basePath = '') {
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
    req: { cookie: (name: string) => jar[name], basePath },
    cookie: setCookie,
    deleteCookie,
    status,
    header,
  } as unknown as Context
  return { ctx, jar, setCookie, deleteCookie }
}

function makeHandler(configure: (options: CookieAuthenticationOptionsBuilder) => unknown = () => undefined) {
  const store = new FakeStore()
  const userProvider = new FakeUserProvider()
  const builder = new CookieAuthenticationOptionsBuilder().sessionSecret(SECRET).rememberMe()
  configure(builder)
  const options = builder.build()
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
    expect(store.map.has(parseToken(jar[REMEMBER])!.series)).toBe(true)
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
    const seriesBefore = parseToken(rememberBefore)!

    const { ctx, jar } = makeCtx({ [REMEMBER]: rememberBefore })
    const result = await handler.authenticate(ctx)

    expect(result.succeeded).toBe(true)
    expect(result.ticket!.principal.findFirst('sub')?.value).toBe('u1')
    expect(result.ticket!.principal.isInRole('admin')).toBe(true) // reloaded via findById
    expect(userProvider.findById).toHaveBeenCalledWith('u1')
    expect(store.rotate).toHaveBeenCalledOnce()
    // rotated: new remember cookie, same series, different token
    const rememberAfter = jar[REMEMBER]
    expect(rememberAfter).toBeDefined()
    expect(rememberAfter).not.toBe(rememberBefore)
    expect(parseToken(rememberAfter!)!.series).toBe(seriesBefore.series)
    // a fresh session cookie was established
    expect(jar[SESSION]).toBeDefined()
  })

  it('detects token theft: known series with a wrong token removes the series and fails', async () => {
    const { handler, store } = makeHandler()
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))
    const series = parseToken(signIn.jar[REMEMBER])!.series

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
    const series = parseToken(remember)!.series
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
    const series = parseToken(signIn.jar[REMEMBER])!.series

    const { ctx, deleteCookie } = makeCtx({ [SESSION]: signIn.jar[SESSION], [REMEMBER]: signIn.jar[REMEMBER] })
    await handler.revoke(ctx)

    expect(store.remove).toHaveBeenCalledWith(series)
    const clearedWith = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }
    expect(deleteCookie).toHaveBeenCalledWith(SESSION, clearedWith)
    expect(deleteCookie).toHaveBeenCalledWith(REMEMBER, clearedWith)
  })

  // The two cookies are one sign-in: scoped to the base the request came in under together, and cleared there
  // together, or signing out leaves the remember-me credential behind at the path it was written at.
  it('writes and clears the remember-me cookie at the base the request came in under', async () => {
    const { handler } = makeHandler()
    const signIn = makeCtx({}, '/api')
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))

    const written = new Map(
      (signIn.setCookie.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>).map(
        ([name, , options]) => [name, options.path],
      ),
    )
    expect(written.get(SESSION)).toBe('/api')
    expect(written.get(REMEMBER)).toBe('/api')

    const { ctx, deleteCookie } = makeCtx({ [SESSION]: signIn.jar[SESSION], [REMEMBER]: signIn.jar[REMEMBER] }, '/api')
    await handler.revoke(ctx)

    const clearedWith = { httpOnly: true, secure: true, sameSite: 'lax', path: '/api' }
    expect(deleteCookie).toHaveBeenCalledWith(SESSION, clearedWith)
    expect(deleteCookie).toHaveBeenCalledWith(REMEMBER, clearedWith)
  })

  /** Signs in with remember-me and hands back the remember cookie alone, as a browser holds it once the session one expired. */
  async function remembered(handler: CookieAuthenticationHandler): Promise<string> {
    const signIn = makeCtx()
    await handler.persist(signIn.ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: true }))

    return signIn.jar[REMEMBER]
  }

  // A route that must not take a remembered session for a fresh sign-in — a change of password — asks for the
  // claim's absence.
  it('marks a session restored from remember-me, and only that one', async () => {
    const { handler } = makeHandler()
    const restored = makeCtx({ [REMEMBER]: await remembered(handler) })

    const result = await handler.authenticate(restored.ctx)

    expect(result.ticket!.principal.hasClaim(REMEMBERED_CLAIM, true)).toBe(true)
    expect(principal().hasClaim(REMEMBERED_CLAIM)).toBe(false)

    // The mark rides in the session cookie it minted, so it holds for the requests that follow too.
    const next = await handler.authenticate(makeCtx({ [SESSION]: restored.jar[SESSION] }).ctx)
    expect(next.ticket!.principal.hasClaim(REMEMBERED_CLAIM, true)).toBe(true)
  })

  // The say the application has over a session cookie, it has here too: a user it no longer accepts is not
  // remembered back in.
  it('asks validatePrincipal before restoring a session, and revokes the series when it says no', async () => {
    const validate = vi.fn().mockReturnValue(null)
    const { handler, store } = makeHandler(o => o.validatePrincipal(validate))
    const remember = await remembered(handler)
    const { ctx, jar } = makeCtx({ [REMEMBER]: remember })

    const result = await handler.authenticate(ctx)

    expect(validate).toHaveBeenCalledOnce()
    expect(result.succeeded).toBe(false)
    expect(store.map.has(parseToken(remember)!.series)).toBe(false)
    expect(jar[SESSION]).toBeUndefined()
    expect(jar[REMEMBER]).toBeUndefined()
  })

  it('reports a refused credential to onFail', async () => {
    const onFail = vi.fn()
    const { handler } = makeHandler(o => o.onFail(onFail))
    const remember = await remembered(handler)
    const { ctx } = makeCtx({ [REMEMBER]: `${parseToken(remember)!.series}:not-the-token` })

    await handler.authenticate(ctx)

    expect(onFail).toHaveBeenCalledWith(ctx, expect.objectContaining({ message: expect.stringContaining('replayed') }))
  })

  // A browser sends a page's requests in parallel, every one with the cookie as it stood when the batch began.
  it('restores the session for a request that lost the rotation to a sibling, without rotating again', async () => {
    const { handler, store } = makeHandler()
    const remember = await remembered(handler)

    const winner = makeCtx({ [REMEMBER]: remember })
    const sibling = makeCtx({ [REMEMBER]: remember })
    const [first, second] = await Promise.all([handler.authenticate(winner.ctx), handler.authenticate(sibling.ctx)])

    expect(first.succeeded).toBe(true)
    expect(second.succeeded).toBe(true)
    expect(store.rotate.mock.results.filter(result => result.value === true)).toHaveLength(1)

    // Exactly one of the two responses carries a new remember cookie, and it is the one that works next.
    const rotatedTo = [winner.jar[REMEMBER], sibling.jar[REMEMBER]].filter(value => value !== remember)
    expect(rotatedTo).toHaveLength(1)
    expect((await handler.authenticate(makeCtx({ [REMEMBER]: rotatedTo[0] }).ctx)).succeeded).toBe(true)
  })

  // Pushed back by every use, the idle lifetime by itself lets a browser that keeps coming back stay remembered
  // for good.
  it('stops remembering once the absolute lifetime is reached, however recently it was used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { handler, store } = makeHandler(o => o.rememberMeMaxAge(3600).rememberMeAbsoluteMaxAge(5000))
      let remember = await remembered(handler)

      vi.setSystemTime(Date.now() + 3000_000)
      const used = makeCtx({ [REMEMBER]: remember })
      expect((await handler.authenticate(used.ctx)).succeeded).toBe(true)
      remember = used.jar[REMEMBER]

      vi.setSystemTime(Date.now() + 2500_000)
      expect((await handler.authenticate(makeCtx({ [REMEMBER]: remember }).ctx)).succeeded).toBe(false)
      expect(store.map.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
