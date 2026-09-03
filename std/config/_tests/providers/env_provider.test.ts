import { describe, expect, it } from 'vitest'

import { EnvConfigProvider } from '../../providers/env_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

describe('EnvConfigProvider', () => {
  it('loads all env vars without prefix, folding underscores into camelCase', async () => {
    const provider = new EnvConfigProvider({ env: { MY_VAR: 'hello' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('myVar')?.value).toBe('hello')
  })

  it('reaches a camelCase key, which is how features spell their settings', async () => {
    const provider = new EnvConfigProvider({ env: { HEALTH__DRAIN_DELAY: '5s' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('health.drainDelay')?.value).toBe('5s')
  })

  it('leaves a single-word segment alone', async () => {
    const provider = new EnvConfigProvider({ env: { SERVER__PORT: '8080' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('server.port')?.value).toBe(8080)
  })

  it('filters by prefix', async () => {
    const provider = new EnvConfigProvider({ prefix: 'APP_', env: { APP_HOST: 'localhost', OTHER: 'ignored' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.has('host')).toBe(true)
    expect(source.entries.has('other')).toBe(false)
  })

  it('transforms APP__DB__HOST to app.db.host via __ separator', async () => {
    const provider = new EnvConfigProvider({ prefix: 'APP_', separator: '__', env: { APP_DB__HOST: 'localhost' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.has('db.host')).toBe(true)
  })

  it('coerces boolean strings', async () => {
    const provider = new EnvConfigProvider({ env: { debug: 'true', enabled: 'false' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('debug')?.value).toBe(true)
    expect(source.entries.get('enabled')?.value).toBe(false)
  })

  it('coerces numeric strings', async () => {
    const provider = new EnvConfigProvider({ env: { PORT: '8080' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('port')?.value).toBe(8080)
  })

  it('keeps string values as-is', async () => {
    const provider = new EnvConfigProvider({ env: { NAME: 'caffeine' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('name')?.value).toBe('caffeine')
  })

  it('sets origin with env: prefix', async () => {
    const provider = new EnvConfigProvider({ env: { APP_PORT: '9000' } })
    const [source] = await provider.load(ctx)
    expect(source.entries.get('appPort')?.origin).toBe('env:APP_PORT')
  })

  // The host seam: a runtime whose environment is not `process.env` passes its own accessor.
  it('accepts a function, called at load time', async () => {
    let calls = 0
    const provider = new EnvConfigProvider({
      env: () => {
        calls++
        return { LAZY: 'read-late' }
      },
    })

    expect(calls).toBe(0)

    const [source] = await provider.load(ctx)

    expect(calls).toBe(1)
    expect(source.entries.get('lazy')?.value).toBe('read-late')
  })

  it('falls back to process.env when given nothing', async () => {
    process.env.CAFFEINE_ENV_FALLBACK_TEST = 'from-process'

    try {
      const [source] = await new EnvConfigProvider().load(ctx)
      expect(source.entries.get('caffeineEnvFallbackTest')?.value).toBe('from-process')
    } finally {
      delete process.env.CAFFEINE_ENV_FALLBACK_TEST
    }
  })
})
