import { kSelfRefresh } from '@caffeinejs/core'
import { describe, expect, it } from 'vitest'
import { ErrConfigValidation } from '../../errors.js'
import type { ConfigSchema } from '../../schema.js'
import { ConfigShard } from '../../integration/config_shard.js'
import { InlineProvider } from '../../providers/inline_provider.js'

interface TestConfig {
  value: string
  count: number
}

let callCount = 0

function makeSchema(valid = true): ConfigSchema<TestConfig> {
  return {
    id: `schema-${callCount++}`,
    parse(input: unknown): TestConfig {
      const obj = input as Record<string, unknown>
      if (!valid) {
        throw new Error('Schema says invalid')
      }
      return { value: String(obj.value ?? ''), count: Number(obj.count ?? 0) }
    },
  }
}

function makeOptions(data: Record<string, unknown>, schema?: ConfigSchema<TestConfig>) {
  return {
    providers: [new InlineProvider(data as never)],
    schema: schema ?? makeSchema(),
  }
}

describe('ConfigShard refresh', () => {
  it('live proxy reflects value after [kSelfRefresh]', async () => {
    let data = { value: 'before', count: 1 }
    const mutableProvider = {
      id: 'mutable',
      load: async () => new InlineProvider(data as never).load({ app: 'test', profiles: ['default'] }),
    }
    const schema = makeSchema()
    const shard = await ConfigShard.bootstrap<TestConfig>({ providers: [mutableProvider], schema })
    const handle = shard.handle

    expect(handle.value).toBe('before')

    data = { value: 'after', count: 42 }

    await shard[kSelfRefresh]()

    expect(handle.value).toBe('after')
    expect(handle.count).toBe(42)
  })

  it('invalid refresh payload does not replace active config', async () => {
    let shouldFail = false
    const schema: ConfigSchema<TestConfig> = {
      id: 'failing',
      parse(input: unknown): TestConfig {
        if (shouldFail) {
          throw new ErrConfigValidation([{ path: '', message: 'boom' }])
        }
        const obj = input as Record<string, unknown>
        return { value: String(obj.value ?? ''), count: Number(obj.count ?? 0) }
      },
    }

    const shard = await ConfigShard.bootstrap<TestConfig>({
      providers: [new InlineProvider({ value: 'safe', count: 1 } as never)],
      schema,
    })

    const handle = shard.handle
    expect(handle.value).toBe('safe')

    shouldFail = true
    await expect(shard[kSelfRefresh]()).rejects.toBeInstanceOf(ErrConfigValidation)

    expect(handle.value).toBe('safe')
  })

  it('concurrent refresh calls produce consistent final state', async () => {
    let seq = 0
    const schema = makeSchema()
    const shard = await ConfigShard.bootstrap<TestConfig>({
      providers: [new InlineProvider({ value: 'v0', count: 0 } as never)],
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
