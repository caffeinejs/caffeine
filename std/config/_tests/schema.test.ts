import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { textList } from '../../schema/text.js'
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

  it('drops keys the schema does not declare instead of rejecting them', () => {
    const result = validateConfig(schema, { host: 'localhost', port: 5432, unrelated: 'other tool' })
    expect(result).toEqual({ host: 'localhost', port: 5432 })
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

/**
 * Configuration is where codecs run, because configuration is where values arrive as text. The same call serves
 * the root schema and every feature slice, so a feature gets them without asking for anything.
 */
describe('validateConfig codecs', () => {
  it('decodes a delimited list', () => {
    const schema = $t.Object({ tags: $t.List($t.String()) })

    expect(validateConfig(schema, { tags: 'a,b,c' })).toEqual({ tags: ['a', 'b', 'c'] })
  })

  it('decodes JSON into an object', () => {
    const schema = $t.Object({ db: $t.JSON($t.Object({ host: $t.String(), port: $t.Number() })) })

    expect(validateConfig(schema, { db: '{"host":"h","port":5432}' })).toEqual({ db: { host: 'h', port: 5432 } })
  })

  it('reports a codec failure as an ordinary issue, at its path', () => {
    const schema = $t.Object({ server: $t.Object({ ports: $t.List($t.Number()) }) })

    try {
      validateConfig(schema, { server: { ports: 'a,b' } })
      expect.unreachable()
    } catch (err) {
      // Not a raw TypeBoxError escaping: a bad value reads like any other validation failure.
      expect(err).toBeInstanceOf(ErrConfigValidation)
      expect((err as ErrConfigValidation).issues[0].path).toBe('server.ports')
    }
  })

  it('reports malformed JSON rather than letting the parser error escape', () => {
    const schema = $t.Object({ db: $t.JSON($t.Object({ host: $t.String() })) })

    expect(() => validateConfig(schema, { db: '{oops' })).toThrow(ErrConfigValidation)
  })

  it('leaves a schema without codecs alone', () => {
    // Declaring none costs nothing: the decode walk is skipped outright.
    const schema = $t.Object({ host: $t.String(), port: $t.Number() })

    expect(validateConfig(schema, { host: 'h', port: '8080' })).toEqual({ host: 'h', port: 8080 })
  })

  it('does nothing automatic for a plain array, which is why the codec is declared', () => {
    // A plain array handed a string does not fail — TypeBox's Convert wraps a scalar into a one-element array,
    // so `TAGS=a,b` silently becomes one element containing a comma. `$t.List` is the difference.
    const plain = $t.Object({ tags: $t.Array($t.String()) })

    expect(validateConfig(plain, { tags: 'a,b' })).toEqual({ tags: ['a,b'] })
  })

  it('leaves a Standard Schema to its own devices, where textList is the way in', () => {
    // zod, valibot and arktype cannot be introspected, so codecs are a `$t` feature and those libraries wrap
    // the splitter themselves.
    const bare = z.object({ tags: z.array(z.string()) })
    expect(() => validateConfig(bare, { tags: 'a,b' })).toThrow(ErrConfigValidation)

    const wrapped = z.object({ tags: z.preprocess(textList, z.array(z.string())) })
    expect(validateConfig(wrapped, { tags: 'a,b' })).toEqual({ tags: ['a', 'b'] })
  })
})
