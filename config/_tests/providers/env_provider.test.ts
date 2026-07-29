import { describe, expect, it } from 'vitest'
import { EnvProvider } from '../../providers/env_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

describe('EnvProvider', () => {
  it('loads all env vars without prefix', async () => {
    const provider = new EnvProvider()
    const [source] = await provider.load({ ...ctx, env: { MY_VAR: 'hello' } })
    expect(source.entries.get('my_var')?.value).toBe('hello')
  })

  it('filters by prefix', async () => {
    const provider = new EnvProvider({ prefix: 'APP_' })
    const [source] = await provider.load({ ...ctx, env: { APP_HOST: 'localhost', OTHER: 'ignored' } })
    expect(source.entries.has('host')).toBe(true)
    expect(source.entries.has('other')).toBe(false)
  })

  it('transforms APP__DB__HOST to app.db.host via __ separator', async () => {
    const provider = new EnvProvider({ prefix: 'APP_', separator: '__' })
    const [source] = await provider.load({ ...ctx, env: { APP_DB__HOST: 'localhost' } })
    expect(source.entries.has('db.host')).toBe(true)
  })

  it('coerces boolean strings', async () => {
    const provider = new EnvProvider()
    const [source] = await provider.load({ ...ctx, env: { debug: 'true', enabled: 'false' } })
    expect(source.entries.get('debug')?.value).toBe(true)
    expect(source.entries.get('enabled')?.value).toBe(false)
  })

  it('coerces numeric strings', async () => {
    const provider = new EnvProvider()
    const [source] = await provider.load({ ...ctx, env: { PORT: '8080' } })
    expect(source.entries.get('port')?.value).toBe(8080)
  })

  it('keeps string values as-is', async () => {
    const provider = new EnvProvider()
    const [source] = await provider.load({ ...ctx, env: { NAME: 'caffeine' } })
    expect(source.entries.get('name')?.value).toBe('caffeine')
  })

  it('sets origin with env: prefix', async () => {
    const provider = new EnvProvider()
    const [source] = await provider.load({ ...ctx, env: { APP_PORT: '9000' } })
    expect(source.entries.get('app_port')?.origin).toBe('env:APP_PORT')
  })
})
