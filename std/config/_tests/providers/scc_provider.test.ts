import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpringCloudConfigProvider } from '../../providers/scc_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { profiles: ['default'] }

function mockFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  let call = 0
  return vi.fn(async () => {
    const r = responses[Math.min(call++, responses.length - 1)]
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? 'OK' : 'Internal Server Error',
      json: async () => r.body,
    }
  })
}

const successBody = {
  name: 'caffeine',
  profiles: ['default'],
  label: 'main',
  version: 'abc123',
  state: 'dirty',
  propertySources: [
    { name: 'file:caffeine.yml', source: { 'caffeine.app': 'my-app', 'caffeine.version': '1.0.0' } },
    { name: 'file:application.yml', source: { 'caffeine.greeting': 'hello' } },
  ],
}

describe('SpringCloudConfigProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps propertySources to PropertySource list in order', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: successBody }]))
    const provider = new SpringCloudConfigProvider({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0 })

    const sources = await provider.load(ctx)
    const names = sources.map(s => s.name)
    expect(names).toContain('spring-cloud-config:file:caffeine.yml')
    expect(names).toContain('spring-cloud-config:file:application.yml')
  })

  it('imports version and state metadata', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: successBody }]))
    const provider = new SpringCloudConfigProvider({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0 })

    const sources = await provider.load(ctx)
    const meta = sources.find(s => s.name === 'spring-cloud-config:metadata')
    expect(meta).toBeDefined()
    expect(meta!.entries.get('config.client.version')?.value).toBe('abc123')
    expect(meta!.entries.get('config.client.state')?.value).toBe('dirty')
  })

  it('metadata source is first in the returned array', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: successBody }]))
    const provider = new SpringCloudConfigProvider({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0 })

    const sources = await provider.load(ctx)
    expect(sources[0].name).toBe('spring-cloud-config:metadata')
  })

  it('fails over to second URL when first is unreachable', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:19999', 'http://localhost:8888'],
      retries: 0,
    })

    const sources = await provider.load(ctx)
    expect(sources.length).toBeGreaterThan(0)
  })

  it('throws ERR_CONFIG_PROVIDER when all URLs fail and optional is false', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: false, status: 503 }]))
    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:19999'],
      retries: 0,
      optional: false,
    })

    await expect(provider.load(ctx)).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_PROVIDER' })
  })

  it('returns empty array when all URLs fail and optional is true', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: false, status: 503 }]))
    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:19999'],
      retries: 0,
      optional: true,
    })

    const sources = await provider.load(ctx)
    expect(sources).toHaveLength(0)
  })

  it('sets origin as scc:<source-name>', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: successBody }]))
    const provider = new SpringCloudConfigProvider({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0 })

    const sources = await provider.load(ctx)
    const ps = sources.find(s => s.name === 'spring-cloud-config:file:caffeine.yml')!
    expect(ps.entries.get('caffeine.app')?.origin).toBe('scc:file:caffeine.yml')
  })

  it('encodes multi-profile path with unencoded comma separator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SpringCloudConfigProvider({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0 })
    await provider.load({ profiles: ['default', 'dev'] })

    const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0]
    expect(url).toContain('/caffeine/default,dev')
    expect(url).not.toContain('%2C')
  })

  it('sends Basic auth header when basicAuth option is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      basicAuth: { username: 'user', password: 'pass' },
      retries: 0,
    })
    await provider.load(ctx)

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Basic ${btoa('user:pass')}`)
  })

  it('authToken takes precedence over basicAuth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      authToken: 'mytoken',
      basicAuth: { username: 'user', password: 'pass' },
      retries: 0,
    })
    await provider.load(ctx)

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer mytoken')
  })

  it('throws immediately on 401 without retrying', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        return { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) }
      }),
    )

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      retries: 3,
      optional: false,
    })

    await expect(provider.load(ctx)).rejects.toThrow()
    expect(callCount).toBe(1)
  })

  it('passes dispatcher to fetch when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const dispatcher = {} as RequestInit['dispatcher']
    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      dispatcher,
      retries: 0,
    })
    await provider.load(ctx)

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(init.dispatcher).toBe(dispatcher)
  })

  it('beforeRequest can add custom headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => successBody })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      beforeRequest: async (_url, init) => ({
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'X-Custom': 'value' },
      }),
      retries: 0,
    })
    await provider.load(ctx)

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['X-Custom']).toBe('value')
  })

  it('beforeRequest is called on each retry attempt', async () => {
    let hookCalls = 0
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => successBody }),
    )

    const provider = new SpringCloudConfigProvider({
      app: 'caffeine',
      baseURLs: ['http://localhost:8888'],
      beforeRequest: async (_url, init) => {
        hookCalls++
        return init
      },
      retries: 1,
    })
    await provider.load(ctx)

    expect(hookCalls).toBe(2)
  })
})
