import { describe, expect, it } from 'vitest'
import { $t } from '../../schema/t.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ErrConfigValidation } from '../errors.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { validateConfig } from '../schema.js'

const schema = $t.Object({
  server: $t.Object({
    host: $t.String({ default: '0.0.0.0' }),
    port: $t.Number({ default: 9999 }),
  }),
})

describe('validateConfig with the $t dialect', () => {
  it('validates and returns the typed value', () => {
    const value = validateConfig(schema, { server: { host: 'localhost', port: 3000 } })
    expect(value).toEqual({ server: { host: 'localhost', port: 3000 } })
  })

  it('coerces string inputs and applies defaults (env-style values)', () => {
    const value = validateConfig(schema, { server: { port: '8080' } })
    expect(value).toEqual({ server: { host: '0.0.0.0', port: 8080 } })
  })

  it('drops keys the schema does not declare instead of rejecting them', () => {
    const value = validateConfig(schema, {
      server: { host: 'localhost', port: 3000, extra: 'ignored' },
      unrelated: 'belongs to another tool',
    })
    expect(value).toEqual({ server: { host: 'localhost', port: 3000 } })
  })

  it('throws ErrConfigValidation with a dotted path on invalid input', () => {
    try {
      validateConfig(schema, { server: { port: 'not-a-number' } })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrConfigValidation)
      expect((err as ErrConfigValidation).issues.some(i => i.path === 'server.port')).toBe(true)
    }
  })

  it('does not mutate the input', () => {
    const input = { server: { port: '8080' } }
    validateConfig(schema, input)
    expect(input).toEqual({ server: { port: '8080' } })
  })

  it('works end to end through bootstrapConfig', async () => {
    const { config } = await bootstrapConfig({
      schema,
      providers: [new InlineConfigProvider({ server: { host: '127.0.0.1', port: 1234 } })],
    })
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.port).toBe(1234)
  })
})
