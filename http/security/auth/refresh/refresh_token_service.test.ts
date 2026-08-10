import { describe, it, expect, vi } from 'vitest'
import { Claim, Identity, Principal } from '../../index.js'
import { JWTService } from '../jwt/jwt_service.js'
import { parseToken } from '../internal/series_token.js'
import { ErrRefreshTokenRejected, RefreshTokenService } from './refresh_token_service.js'
import { type RefreshTokenRecord, RefreshTokenStore } from './refresh_token_store.js'
import type { RefreshPrincipalResolver } from './refresh_options.js'

const jwt = new JWTService({ secret: 'a-very-long-test-secret-key-32-bytes!', issuer: 'test' })

class FakeStore extends RefreshTokenStore {
  readonly map = new Map<string, RefreshTokenRecord>()
  create = vi.fn((r: RefreshTokenRecord) => { this.map.set(r.series, { ...r }) })
  findBySeries = vi.fn((s: string) => this.map.get(s) ?? null)
  updateToken = vi.fn((s: string, tokenHash: string, expiresAt: number) => {
    const r = this.map.get(s)
    if (r) {
      r.tokenHash = tokenHash
      r.expiresAt = expiresAt
    }
  })

  remove = vi.fn((s: string) => { this.map.delete(s) })
  removeBySubject = vi.fn((sub: string) => {
    for (const [k, v] of this.map) {
      if (v.subject === sub) {
        this.map.delete(k)
      }
    }
  })
}

function principal(sub = 'u1', roles: string[] = ['admin']): Principal {
  return new Principal(true, new Identity('Test', true, [new Claim('sub', sub, ''), new Claim('roles', roles, '')]))
}

function make(resolve = vi.fn<RefreshPrincipalResolver>(async (sub: string) => principal(sub))) {
  const store = new FakeStore()
  const service = new RefreshTokenService(jwt, store, { resolve, accessTTL: '15m', refreshTTL: '30d' })
  return { store, service, resolve }
}

describe('RefreshTokenService', () => {
  it('issue: stores a hashed token and signs a verifiable access JWT', async () => {
    const { store, service } = make()

    const pair = await service.issue(principal())

    expect(store.create).toHaveBeenCalledOnce()
    const rec = store.create.mock.calls[0][0]
    expect(rec.subject).toBe('u1')
    // the raw token is never stored
    const { series, token } = parseToken(pair.refreshToken)!
    expect(store.map.has(series)).toBe(true)
    expect(rec.tokenHash).not.toBe(token)

    const payload = await jwt.verify(pair.accessToken)
    expect(payload.sub).toBe('u1')
    expect(payload.roles).toEqual(['admin'])
  })

  it('refresh: rotates the token, reloads the principal, re-signs the access token', async () => {
    const { store, service, resolve } = make()
    const first = await service.issue(principal())
    const seriesBefore = parseToken(first.refreshToken)!.series

    const next = await service.refresh(first.refreshToken)

    expect(resolve).toHaveBeenCalledWith('u1', expect.objectContaining({ series: seriesBefore }))
    expect(store.updateToken).toHaveBeenCalledOnce()
    // same series, different token
    expect(parseToken(next.refreshToken)!.series).toBe(seriesBefore)
    expect(next.refreshToken).not.toBe(first.refreshToken)
    expect((await jwt.verify(next.accessToken)).sub).toBe('u1')
  })

  it('detects theft: replaying a pre-rotation token revokes the series', async () => {
    const { store, service } = make()
    const first = await service.issue(principal())
    const series = parseToken(first.refreshToken)!.series
    await service.refresh(first.refreshToken) // rotates

    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(ErrRefreshTokenRejected)
    expect(store.remove).toHaveBeenCalledWith(series)
    expect(store.map.has(series)).toBe(false)
  })

  it('rejects and removes an expired record', async () => {
    const { store, service } = make()
    const first = await service.issue(principal())
    const series = parseToken(first.refreshToken)!.series
    store.map.get(series)!.expiresAt = Math.floor(Date.now() / 1000) - 10

    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(ErrRefreshTokenRejected)
    expect(store.remove).toHaveBeenCalledWith(series)
  })

  it('rejects an unknown series and a malformed token', async () => {
    const { service } = make()
    await expect(service.refresh('ghost:token')).rejects.toBeInstanceOf(ErrRefreshTokenRejected)
    await expect(service.refresh('not-a-token')).rejects.toBeInstanceOf(ErrRefreshTokenRejected)
  })

  it('rejects and removes when the resolver returns null (user gone/disabled)', async () => {
    const { store, service } = make(vi.fn<RefreshPrincipalResolver>(async () => null))
    const first = await service.issue(principal())
    const series = parseToken(first.refreshToken)!.series

    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(ErrRefreshTokenRejected)
    expect(store.remove).toHaveBeenCalledWith(series)
  })

  it('revoke removes one series; revokeAllForSubject removes every series of a subject', async () => {
    const { store, service } = make()
    const a = await service.issue(principal('u1'))
    await service.issue(principal('u1'))
    expect([...store.map.values()].filter(r => r.subject === 'u1')).toHaveLength(2)

    await service.revoke(a.refreshToken)
    expect(store.remove).toHaveBeenCalledWith(parseToken(a.refreshToken)!.series)

    await service.revokeAllForSubject('u1')
    expect(store.removeBySubject).toHaveBeenCalledWith('u1')
    expect([...store.map.values()].filter(r => r.subject === 'u1')).toHaveLength(0)
  })

  it('issue throws when the principal has no sub claim', async () => {
    const { service } = make()
    const noSub = new Principal(true, new Identity('Test', true, [new Claim('roles', ['x'], '')]))
    await expect(service.issue(noSub)).rejects.toThrow('principal has no "sub" claim')
  })
})
