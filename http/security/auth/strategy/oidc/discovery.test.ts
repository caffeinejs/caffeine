import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchDiscovery } from './discovery.js'

const DISCOVERY: Record<string, unknown> = {
  issuer: 'https://example.com',
  authorization_endpoint: 'https://example.com/auth',
  token_endpoint: 'https://example.com/token',
  jwks_uri: 'https://example.com/.well-known/jwks.json',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(DISCOVERY),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchDiscovery()', () => {
  it('appends /.well-known/openid-configuration when not already present', async () => {
    await fetchDiscovery('https://example.com')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('strips trailing slash before appending path', async () => {
    await fetchDiscovery('https://example.com/')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does not double-append when URL already ends with the well-known path', async () => {
    await fetchDiscovery('https://example.com/.well-known/openid-configuration')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('returns the parsed discovery document', async () => {
    const doc = await fetchDiscovery('https://example.com')
    expect(doc).toEqual(DISCOVERY)
  })

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('"https://example.com/.well-known/openid-configuration" returned 404')
  })

  it('throws when a required field is missing', async () => {
    const { jwks_uri: _omitted, ...incomplete } = DISCOVERY
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(incomplete),
    }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('is missing "jwks_uri"')
  })

  it('rejects a document advertising a non-https endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...DISCOVERY, token_endpoint: 'http://evil.example.com/token' }),
    }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('must use https')
  })

  it('allows an http loopback endpoint for local development', async () => {
    const local = {
      issuer: 'http://localhost:8080',
      authorization_endpoint: 'http://localhost:8080/auth',
      token_endpoint: 'http://localhost:8080/token',
      jwks_uri: 'http://localhost:8080/jwks',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(local),
    }))
    await expect(fetchDiscovery('http://localhost:8080')).resolves.toEqual(local)
  })

  it('surfaces a network failure rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted')))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('The operation was aborted')
  })
})
