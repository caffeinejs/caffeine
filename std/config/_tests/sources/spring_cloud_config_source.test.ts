import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeLayers } from '../../merge.js'
import {
  SpringCloudConfigSource,
  type SpringCloudConfigSourceOptions,
} from '../../sources/spring_cloud_config_source.js'
import type { ConfigLoadContext, ConfigSource } from '../../types.js'

function context(profiles: string[] = ['default'], signal = new AbortController().signal): ConfigLoadContext {
  return { profiles, signal, logger: undefined as never }
}

function respond(responses: { ok: boolean; status?: number; body?: unknown }[]) {
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

const body = {
  name: 'caffeine',
  profiles: ['default'],
  label: 'main',
  version: 'abc123',
  state: 'dirty',
  // Highest precedence first, as a config server lists them.
  propertySources: [
    { name: 'file:caffeine-dev.yml', source: { 'caffeine.greeting': 'hello from dev', 'servers[0].host': 'h' } },
    { name: 'file:application.yml', source: { 'caffeine.greeting': 'hello', 'caffeine.app': 'my-app' } },
  ],
}

function source(options: Partial<SpringCloudConfigSourceOptions> = {}): SpringCloudConfigSource {
  return new SpringCloudConfigSource({ app: 'caffeine', baseURLs: ['http://localhost:8888'], retries: 0, ...options })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SpringCloudConfigSource', () => {
  it('turns the property sources into layers, the one listed first winning', async () => {
    vi.stubGlobal('fetch', respond([{ ok: true, body }]))

    const layers = await source().load(context())

    expect(layers.map(l => l.name)).toEqual([
      'spring-cloud-config:file:application.yml',
      'spring-cloud-config:file:caffeine-dev.yml',
      'spring-cloud-config:metadata',
    ])
    expect((mergeLayers(layers) as { caffeine: { greeting: string } }).caffeine.greeting).toBe('hello from dev')
  })

  it('expands dotted and bracketed keys into a tree', async () => {
    vi.stubGlobal('fetch', respond([{ ok: true, body }]))

    const [, dev] = await source().load(context())

    expect(dev.data).toEqual({ caffeine: { greeting: 'hello from dev' }, servers: [{ host: 'h' }] })
  })

  it('adds the version and state the server reported, last', async () => {
    vi.stubGlobal('fetch', respond([{ ok: true, body }]))

    const layers = await source().load(context())

    expect(layers.at(-1)).toEqual({
      name: 'spring-cloud-config:metadata',
      data: { config: { client: { version: 'abc123', state: 'dirty' } } },
    })
    expect(await source({ includeMetadata: false }).load(context())).toHaveLength(2)
  })

  it('is live, and carries what the store reads off it', () => {
    const polled: ConfigSource = source({ optional: true, pollInterval: '30s', name: 'remote' })

    expect(polled).toMatchObject({ name: 'remote', live: true, optional: true, pollInterval: '30s' })
    expect(source()).toMatchObject({ name: 'spring-cloud-config', optional: false, pollInterval: undefined })
  })

  it('fails over to the second URL when the first is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, json: async () => body }),
    )

    const layers = await source({ baseURLs: ['http://localhost:19999', 'http://localhost:8888'] }).load(context())

    expect(layers.length).toBeGreaterThan(0)
  })

  // An outage is a failure, not an empty answer: the store keeps what it had and says so.
  it('throws when every URL fails, optional or not', async () => {
    vi.stubGlobal('fetch', respond([{ ok: false, status: 503 }]))

    for (const optional of [false, true]) {
      await expect(source({ optional }).load(context())).rejects.toMatchObject({
        name: 'ErrConfig',
        code: 'ERR_CONFIG_SOURCE',
        message: expect.stringContaining('answered 503'),
      })
    }
  })

  it('sends the profiles comma-separated, and default when there is none', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    vi.stubGlobal('fetch', fetch)

    await source().load(context(['default', 'dev']))
    await source({ label: 'release/1' }).load(context([]))

    expect(fetch.mock.calls[0][0]).toBe('http://localhost:8888/caffeine/default,dev')
    expect(fetch.mock.calls[1][0]).toBe('http://localhost:8888/caffeine/default/release%2F1')
  })

  it('sends basic authentication, and a bearer token in preference to it', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    vi.stubGlobal('fetch', fetch)

    await source({ basicAuth: { username: 'user', password: 'pass' } }).load(context())
    await source({ authToken: 'token', basicAuth: { username: 'user', password: 'pass' } }).load(context())

    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${btoa('user:pass')}`,
    })
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token' })
  })

  it('does not retry a 4xx', async () => {
    const fetch = respond([{ ok: false, status: 401 }])
    vi.stubGlobal('fetch', fetch)

    await expect(source({ retries: 3 }).load(context())).rejects.toThrow('answered 401')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx, calling beforeRequest before every attempt', async () => {
    const fetch = respond([
      { ok: false, status: 503 },
      { ok: true, body },
    ])
    vi.stubGlobal('fetch', fetch)
    const beforeRequest = vi.fn(async (_url: string, init: RequestInit) => ({
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'X-Custom': 'value' },
    }))

    await source({ retries: 1, beforeRequest }).load(context())

    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect((fetch.mock.calls[1] as unknown[])[1]).toMatchObject({ headers: { 'X-Custom': 'value' } })
  })

  it('passes the dispatcher through to fetch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    vi.stubGlobal('fetch', fetch)
    const dispatcher = {} as RequestInit['dispatcher']

    await source({ dispatcher }).load(context())

    expect((fetch.mock.calls[0][1] as RequestInit).dispatcher).toBe(dispatcher)
  })

  // The store aborts a load that timed out or a store that closed. Retrying after that is work nobody will read.
  it('stops at once when the store aborts the load', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort(new Error('the store gave up'))
      throw init.signal?.reason
    })
    vi.stubGlobal('fetch', fetch)

    await expect(
      source({ retries: 3, baseURLs: ['http://a', 'http://b'] }).load(context(['default'], controller.signal)),
    ).rejects.toThrow('the store gave up')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
