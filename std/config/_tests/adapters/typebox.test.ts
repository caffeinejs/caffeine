import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { bootstrapConfig } from '../../bootstrap.js'
import { ErrConfigValidation } from '../../errors.js'
import { InlineProvider } from '../../providers/inline_provider.js'
import { validateConfig } from '../../schema.js'
import { typebox } from '../../adapters/typebox.js'

const schema = typebox(Type.Object({
  server: Type.Object({
    host: Type.String({ default: '0.0.0.0' }),
    port: Type.Number({ default: 9999 }),
  }),
}))

describe('typebox adapter', () => {
  it('validates and returns the typed value', () => {
    const value = validateConfig(schema, { server: { host: 'localhost', port: 3000 } })
    expect(value).toEqual({ server: { host: 'localhost', port: 3000 } })
  })

  it('coerces string inputs and applies defaults (env-style values)', () => {
    const value = validateConfig(schema, { server: { port: '8080' } })
    expect(value).toEqual({ server: { host: '0.0.0.0', port: 8080 } })
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

  it('works end to end through bootstrapConfig', async () => {
    const { config } = await bootstrapConfig({
      schema,
      providers: [new InlineProvider({ server: { host: '127.0.0.1', port: 1234 } })],
    })
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.port).toBe(1234)
  })
})
