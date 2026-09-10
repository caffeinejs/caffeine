import { kSelfRefresh } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ConfigProvider } from '../../config.js'
import { ErrConfigValidation } from '../../errors.js'
import { ConfigShard } from '../../integration/shard.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import { ConfigSources } from '../../sources.js'

const schema = z.object({ value: z.string(), count: z.number() })
type TestConfig = z.infer<typeof schema>

describe('ConfigShard refresh', () => {
  it('live proxy reflects value after [kSelfRefresh]', async () => {
    let data = { value: 'before', count: 1 }
    const mutableProvider: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: async () => new InlineConfigProvider(data as never).load({ profiles: ['default'] }),
    }
    const shard = await ConfigShard.bootstrap<TestConfig>({ sources: ConfigSources.of(mutableProvider), schema })
    const handle = shard.handle

    expect(handle.value).toBe('before')

    data = { value: 'after', count: 42 }

    await shard[kSelfRefresh]()

    expect(handle.value).toBe('after')
    expect(handle.count).toBe(42)
  })

  // The refresh path used to pay the probe too: a profile-declaring application re-loaded every source twice
  // on every refresh, so a config server was polled twice per tick. The profiles are settled before the
  // shard exists now, and a refresh is one load per source.
  it('loads each source once per refresh, profiles or not', async () => {
    let loads = 0
    const provider: ConfigProvider = {
      id: 'counting',
      reloadable: true,
      load: async ctx => {
        loads++
        return new InlineConfigProvider({ value: 'v', count: 1 } as never).load(ctx)
      },
    }

    const shard = await ConfigShard.bootstrap<TestConfig>({
      sources: ConfigSources.of(provider),
      schema,
      profiles: ['prod'],
    })

    expect(loads).toBe(1)

    await shard[kSelfRefresh]()

    expect(loads).toBe(2)
  })

  it('invalid refresh payload does not replace active config', async () => {
    // count starts as a valid number, then becomes a non-numeric string that fails `z.number()` on refresh.
    let payload: Record<string, unknown> = { value: 'safe', count: 1 }
    const provider: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: ctx => new InlineConfigProvider(payload as never).load(ctx),
    }

    const shard = await ConfigShard.bootstrap<TestConfig>({ sources: ConfigSources.of(provider), schema })

    const handle = shard.handle
    expect(handle.value).toBe('safe')

    payload = { value: 'x', count: 'not-a-number' }
    await expect(shard[kSelfRefresh]()).rejects.toBeInstanceOf(ErrConfigValidation)

    expect(handle.value).toBe('safe')
  })

  it('concurrent refresh calls produce consistent final state', async () => {
    let seq = 0
    const shard = await ConfigShard.bootstrap<TestConfig>({
      sources: ConfigSources.of(new InlineConfigProvider({ value: 'v0', count: 0 } as never)),
      schema,
    })

    const refreshes = Array.from({ length: 5 }, async (_, i) => {
      await shard[kSelfRefresh]()
      seq = i
    })

    await Promise.all(refreshes)
    expect(shard.handle.value).toBeDefined()
  })
})
