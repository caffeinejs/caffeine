import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ErrConfigValidation } from '../errors.js'
import type { ConfigSchema } from '../schema.js'
import { validateConfig } from '../schema.js'

interface TestConfig {
  host: string
  port: number
}

const schema = z.object({ host: z.string(), port: z.number() })

describe('validateConfig', () => {
  it('returns the typed value on valid input', () => {
    const result = validateConfig(schema, { host: 'localhost', port: 5432 })
    expect(result).toEqual({ host: 'localhost', port: 5432 })
  })

  it('throws ErrConfigValidation with mapped issues on invalid input', () => {
    try {
      validateConfig(schema, { host: 123, port: 'bad' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrConfigValidation)
      const e = err as ErrConfigValidation
      const paths = e.issues.map(i => i.path).sort()
      expect(paths).toEqual(['host', 'port'])
      expect(e.code).toBe('ERR_CONFIG_VALIDATION')
    }
  })

  it('joins nested Standard Schema path segments with dots', () => {
    const nested = z.object({ server: z.object({ port: z.number() }) })
    try {
      validateConfig(nested, { server: { port: 'nope' } })
      expect.unreachable()
    } catch (err) {
      expect((err as ErrConfigValidation).issues[0].path).toBe('server.port')
    }
  })

  it('rejects an async validator (config is materialized synchronously)', () => {
    const asyncSchema: ConfigSchema<TestConfig> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => Promise.resolve({ value: { host: 'a', port: 1 } }),
      },
    }
    expect(() => validateConfig(asyncSchema, {})).toThrowError(/Async schema validation is not supported/)
  })
})
