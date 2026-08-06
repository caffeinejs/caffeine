import { describe, it, expect, vi, afterEach } from 'vitest'
import { sealSession, unsealSession } from './_session_cookie.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'

afterEach(() => {
  vi.useRealTimers()
})

describe('session cookie sealing', () => {
  it('round-trips a payload', async () => {
    const sealed = await sealSession({ scheme: 'Cookie', sub: 'u1' }, SECRET, 'Cookie', 3600)
    const payload = await unsealSession<{ scheme: string, sub: string }>(sealed, SECRET, 'Cookie')
    expect(payload.scheme).toBe('Cookie')
    expect(payload.sub).toBe('u1')
  })

  it('rejects a tampered cookie', async () => {
    const sealed = await sealSession({ sub: 'u1' }, SECRET, 'Cookie', 3600)
    const tampered = `${sealed.slice(0, -3)}xyz`
    await expect(unsealSession(tampered, SECRET, 'Cookie')).rejects.toThrow()
  })

  it('rejects a cookie sealed under a different secret', async () => {
    const sealed = await sealSession({ sub: 'u1' }, SECRET, 'Cookie', 3600)
    await expect(unsealSession(sealed, 'a-completely-different-secret-32bytes!!', 'Cookie')).rejects.toThrow()
  })

  it('rejects a cookie sealed under a different scheme name', async () => {
    const sealed = await sealSession({ sub: 'u1' }, SECRET, 'Cookie', 3600)
    await expect(unsealSession(sealed, SECRET, 'OtherCookie')).rejects.toThrow()
  })

  it('rejects an expired cookie', async () => {
    vi.useFakeTimers()
    const sealed = await sealSession({ sub: 'u1' }, SECRET, 'Cookie', 60)
    vi.setSystemTime(Date.now() + 120_000)
    await expect(unsealSession(sealed, SECRET, 'Cookie')).rejects.toThrow()
  })
})
