import { loadConfig } from '@caffeinejs/application/config'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configuration } from './app.config.js'

// Each profile the example documents loads and passes the schema, with the values that make it what it is.

afterEach(() => {
  vi.unstubAllEnvs()
})

async function load(...profiles: string[]) {
  // Only the profiles the test names: the Vitest config sets CAFFEINE_PROFILES=test for every other test.
  vi.stubEnv('CAFFEINE_PROFILES', '')
  const store = await loadConfig(configuration, { profiles, start: false })
  try {
    return store.current
  } finally {
    await store.close()
  }
}

describe('the configuration', () => {
  it('calls the eight local DSPs on the host, with resilience on', async () => {
    const config = await load()

    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 9500 })
    expect(config.exchange.resilience).toBe(true)
    expect(config.dsps.map(dsp => dsp.url)).toEqual([
      'http://127.0.0.1:8101',
      'http://127.0.0.1:8102',
      'http://127.0.0.1:8103',
      'http://127.0.0.1:8104',
      'http://127.0.0.1:8105',
      'http://127.0.0.1:8106',
      'http://127.0.0.1:8107',
      'http://127.0.0.1:8108',
    ])
    expect(config.resilience.defaults.timeLimiter?.timeoutDuration).toBe(80)
  })

  it('calls the DSPs by their compose service names under the docker profile', async () => {
    const config = await load('docker')

    expect(config.server.host).toBe('0.0.0.0')
    expect(config.dsps.map(dsp => dsp.url)).toEqual([
      'http://dsp-alpha:8080',
      'http://dsp-bravo:8080',
      'http://dsp-charlie:8080',
      'http://dsp-delta:8080',
      'http://dsp-echo:8080',
      'http://dsp-dead:8080',
      'http://dsp-slow:8080',
      'http://dsp-flaky:8080',
    ])
    expect(config.dsps.find(dsp => dsp.id === 'dsp-echo')?.qps).toBe(500)
  })

  it('turns resilience off under the bare profile, on top of docker', async () => {
    const config = await load('docker', 'bare')

    expect(config.exchange.resilience).toBe(false)
    expect(config.dsps[0]?.url).toBe('http://dsp-alpha:8080')
  })

  it('shrinks every window under the test profile', async () => {
    const config = await load('test')

    expect(config.server.port).toBe(0)
    expect(config.resilience.defaults.circuitBreaker?.minimumNumberOfCalls).toBe(4)
    expect(config.resilience.presets['win-notice']?.retry?.backoff).toEqual({ type: 'fixed', delay: 1 })
  })
})
