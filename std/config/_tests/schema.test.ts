import { describe, expect, it } from 'vitest'
import { ErrConfigValidation } from '../errors.js'
import type { ConfigSchema } from '../schema.js'
import { validateConfig } from '../schema.js'

interface TestConfig {
  host: string
  port: number
}

const strictSchema: ConfigSchema<TestConfig> = {
  id: 'test',
  parse(input: unknown): TestConfig {
    const obj = input as Record<string, unknown>
    if (typeof obj.host !== 'string') {
      throw new Error('host must be a string')
    }
    if (typeof obj.port !== 'number') {
      throw new Error('port must be a number')
    }
    return { host: obj.host, port: obj.port }
  },
}

const zodLikeSchema: ConfigSchema<TestConfig> = {
  id: 'zod-like',
  parse(input: unknown): TestConfig {
    const obj = input as Record<string, unknown>
    const issues = []
    if (typeof obj.host !== 'string') {
      issues.push({ path: 'host', message: 'Required', code: 'invalid_type' })
    }
    if (typeof obj.port !== 'number') {
      issues.push({ path: 'port', message: 'Required', code: 'invalid_type' })
    }
    if (issues.length > 0) {
      throw Object.assign(new Error('Validation failed'), { issues })
    }
    return { host: obj.host as string, port: obj.port as number }
  },
}

describe('validateConfig', () => {
  it('returns typed value on valid input', () => {
    const result = validateConfig(strictSchema, { host: 'localhost', port: 5432 })
    expect(result).toEqual({ host: 'localhost', port: 5432 })
  })

  it('wraps plain Error into ErrConfigValidation', () => {
    expect(() => validateConfig(strictSchema, { host: 123, port: 5432 })).toThrowError(ErrConfigValidation)
  })

  it('wraps Zod-like issues array into ErrConfigValidation', () => {
    try {
      validateConfig(zodLikeSchema, { host: 123, port: 'bad' })
    } catch (err) {
      expect(err).toBeInstanceOf(ErrConfigValidation)
      const e = err as ErrConfigValidation
      expect(e.issues).toHaveLength(2)
      expect(e.issues[0].path).toBe('host')
      expect(e.issues[1].path).toBe('port')
    }
  })

  it('preserves ErrConfigValidation thrown directly by schema', () => {
    const schema: ConfigSchema<TestConfig> = {
      id: 'direct',
      parse() {
        throw new ErrConfigValidation([{ path: 'x', message: 'nope' }])
      },
    }
    expect(() => validateConfig(schema, {})).toThrowError(ErrConfigValidation)
  })

  it('sets code ERR_CONFIG_VALIDATION', () => {
    try {
      validateConfig(strictSchema, {})
    } catch (err) {
      expect((err as ErrConfigValidation).code).toBe('ERR_CONFIG_VALIDATION')
    }
  })
})
