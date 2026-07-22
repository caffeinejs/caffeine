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

  // Optional in the document, so it is easy to miss in the required-field loop — but the
  // UserInfo request carries the access token in an Authorization header, and over plain http
  // that hands a live credential to anyone on the path.
  it('rejects a non-https userinfo_endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...DISCOVERY, userinfo_endpoint: 'http://evil.example.com/userinfo' }),
    }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('must use https')
  })

  // Valid JSON that is not an object would throw a bare TypeError at the first field access,
  // outside the parse catch, surfacing as a 500 rather than a typed discovery error.
  it('rejects a document body that is not a JSON object', async () => {
    for (const body of [null, [1, 2], 'a string']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(body),
      }))
      await expect(fetchDiscovery('https://example.com')).rejects.toThrow('is not a JSON object')
    }
  })

  it('rejects a non-array code_challenge_methods_supported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...DISCOVERY, code_challenge_methods_supported: {} }),
    }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('malformed "code_challenge_methods_supported"')
  })

  it('rejects a token_endpoint_auth_methods_supported that is not an array of strings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...DISCOVERY, token_endpoint_auth_methods_supported: [1, 2] }),
    }))
    await expect(fetchDiscovery('https://example.com')).rejects.toThrow('malformed "token_endpoint_auth_methods_supported"')
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
