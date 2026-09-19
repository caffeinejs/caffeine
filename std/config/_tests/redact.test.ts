import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { REDACTED, collectSecretPaths, isSecretPath, redactValue } from '../redact.js'

describe('collectSecretPaths', () => {
  it('finds a marked leaf', () => {
    const schema = $t.Object({ issuer: $t.String(), secret: $t.Secret($t.String()) })

    expect(collectSecretPaths(schema)).toEqual([['secret']])
  })

  it('descends into nested objects', () => {
    const schema = $t.Object({ db: $t.Object({ host: $t.String(), password: $t.Secret($t.String()) }) })

    expect(collectSecretPaths(schema)).toEqual([['db', 'password']])
  })

  // Marking the parent has to be enough, or it is a false reassurance.
  it('marks a whole object without descending into it', () => {
    const schema = $t.Object({ credentials: $t.Secret($t.Object({ user: $t.String(), password: $t.String() })) })

    expect(collectSecretPaths(schema)).toEqual([['credentials']])
  })

  it('sees through Optional', () => {
    expect(collectSecretPaths($t.Object({ secret: $t.Optional($t.Secret($t.String())) }))).toEqual([['secret']])
  })

  // An element's index, or a record's key, is not known until a value exists.
  it('marks array items and record values at any key', () => {
    const schema = $t.Object({
      tokens: $t.Array($t.Secret($t.String())),
      servers: $t.Array($t.Object({ host: $t.String(), password: $t.Secret($t.String()) })),
      vaults: $t.Record($t.String(), $t.Object({ key: $t.Secret($t.String()) })),
    })

    expect(collectSecretPaths(schema)).toEqual([
      ['tokens', '*'],
      ['servers', '*', 'password'],
      ['vaults', '*', 'key'],
    ])
  })

  // An application declares a feature's exported schema wherever it needs one, so one schema object can sit at two
  // paths. A secret found at the first and missed at the second is shown in clear.
  it('finds a secret at every path one schema object is used at', () => {
    const credentials = $t.Object({ user: $t.String(), password: $t.Secret($t.String()) })
    const token = $t.Secret($t.String())
    const schema = $t.Object({ primary: credentials, replica: $t.Optional(credentials), api: token, admin: token })

    expect(collectSecretPaths(schema)).toEqual([['primary', 'password'], ['replica', 'password'], ['api'], ['admin']])
  })

  it('stops at a schema that contains itself', () => {
    const properties: Record<string, unknown> = { secret: $t.Secret($t.String()) }
    const schema = { type: 'object', properties }
    properties.self = schema

    expect(collectSecretPaths(schema)).toEqual([['secret']])
  })

  it('finds nothing in a schema that marked nothing', () => {
    expect(collectSecretPaths($t.Object({ host: $t.String() }))).toEqual([])
  })

  // A foreign schema exposes no shape to walk.
  it('finds nothing in a foreign Standard Schema', () => {
    expect(collectSecretPaths(z.object({ secret: z.string() }))).toEqual([])
  })
})

describe('isSecretPath', () => {
  const secrets = [
    ['auth', 'secret'],
    ['db', 'credentials'],
    ['servers', '*', 'password'],
  ]

  it('matches the marked path itself', () => {
    expect(isSecretPath(['auth', 'secret'], secrets)).toBe(true)
  })

  it('matches anything beneath a marked path', () => {
    expect(isSecretPath(['db', 'credentials', 'password'], secrets)).toBe(true)
  })

  it('does not match a sibling or a prefix', () => {
    expect(isSecretPath(['auth', 'issuer'], secrets)).toBe(false)
    expect(isSecretPath(['auth'], secrets)).toBe(false)
    expect(isSecretPath([], secrets)).toBe(false)
  })

  it('matches any index or key where the schema had items or a record', () => {
    expect(isSecretPath(['servers', '0', 'password'], secrets)).toBe(true)
    expect(isSecretPath(['servers', '7', 'password'], secrets)).toBe(true)
    expect(isSecretPath(['servers', '0', 'host'], secrets)).toBe(false)
  })

  // Split paths need no escape: a key holding a dot is one segment, a different thing from two.
  it('keeps a segment holding a literal dot apart from two segments', () => {
    const dotted = [['a.b']]

    expect(isSecretPath(['a.b'], dotted)).toBe(true)
    expect(isSecretPath(['a.b', 'password'], dotted)).toBe(true)
    expect(isSecretPath(['a', 'b', 'password'], dotted)).toBe(false)
  })
})

describe('redactValue', () => {
  const secrets = [['db', 'password'], ['creds.v2'], ['servers', '*', 'password']]

  it('replaces a secret at any depth and keeps the shape', () => {
    const value = {
      db: { host: 'h', password: 'p' },
      'creds.v2': { token: 't' },
      servers: [{ host: 'a', password: 'x' }],
    }

    expect(redactValue(value, [], secrets)).toEqual({
      db: { host: 'h', password: REDACTED },
      'creds.v2': REDACTED,
      servers: [{ host: 'a', password: REDACTED }],
    })
  })

  it('redacts a value read one level up from the secret', () => {
    expect(redactValue({ host: 'h', password: 'p' }, ['db'], secrets)).toEqual({ host: 'h', password: REDACTED })
  })

  it('replaces the value read at a secret path', () => {
    expect(redactValue('p', ['db', 'password'], secrets)).toBe(REDACTED)
  })

  it('never touches the original', () => {
    const value = { db: { password: 'p' } }
    redactValue(value, [], secrets)

    expect(value.db.password).toBe('p')
  })

  it('hands back a value that holds no secret as it is', () => {
    const value = { cache: { ttl: 1 } }

    expect(redactValue(value, [], secrets)).toEqual(value)
    expect(redactValue(value.cache, ['cache'], secrets)).toBe(value.cache)
  })
})
