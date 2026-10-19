import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { textList } from '../../schema/text.js'
import { ErrConfigValidation } from '../errors.js'
import { validateConfig } from '../schema.js'
import type { ConfigSchema } from '../types.js'

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

  // The error reaches whoever called, and whatever logs it, and a configuration value may be a secret. A parser
  // quotes the text it rejected: JSON.parse says `"hunter2" is not valid JSON`.
  it('keeps the text a codec could not parse out of the error', () => {
    const json = $t.Object({ credentials: $t.JSON($t.Object({ key: $t.String() })) })

    try {
      validateConfig(json, { credentials: 'hunter2' })
      expect.unreachable()
    } catch (err) {
      expect((err as ErrConfigValidation).issues).toEqual([
        { path: 'credentials', message: 'The value is not valid JSON', code: 'Decode' },
      ])
      expect((err as ErrConfigValidation).message).not.toContain('hunter2')
    }
  })

  it('keeps what a custom list parser threw out of the error', () => {
    const parse = (raw: string): unknown[] => {
      throw new Error(`cannot read "${raw}"`)
    }
    const list = $t.Object({ keys: $t.List($t.Number(), { parse }) })

    try {
      validateConfig(list, { keys: 'hunter2' })
      expect.unreachable()
    } catch (err) {
      expect((err as ErrConfigValidation).issues).toEqual([
        { path: 'keys', message: 'The value could not be parsed as a list', code: 'Decode' },
      ])
      expect((err as ErrConfigValidation).message).not.toContain('hunter2')
    }
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

// An application declares its blocks and their field defaults; it does not also have to write `{ default: {} }`
// on every block to make an unconfigured one exist.
describe('validateConfig and blocks nobody configured', () => {
  it('resolves a block absent from every source to its field defaults', () => {
    const schema = $t.Object({
      server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number({ default: 9999 }) }),
      log: $t.Object({ level: $t.String({ default: 'info' }) }),
    })

    expect(validateConfig(schema as ConfigSchema<unknown>, {})).toEqual({
      server: { host: '0.0.0.0', port: 9999 },
      log: { level: 'info' },
    })
  })

  it('still refuses a block whose fields are required and undefaulted, naming the field', () => {
    const schema = $t.Object({ auth: $t.Object({ clientId: $t.String() }) })

    try {
      validateConfig(schema as ConfigSchema<unknown>, {})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ErrConfigValidation)
      expect((err as ErrConfigValidation).issues.map(i => i.path)).toContain('auth.clientId')
    }
  })

  it('lets a partially configured block keep what was set and default the rest', () => {
    const schema = $t.Object({
      server: $t.Object({ host: $t.String({ default: '0.0.0.0' }), port: $t.Number({ default: 9999 }) }),
    })

    expect(validateConfig(schema as ConfigSchema<unknown>, { server: { port: '3000' } })).toEqual({
      server: { host: '0.0.0.0', port: 3000 },
    })
  })
})
