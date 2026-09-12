import { token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { bootstrapConfig } from '../bootstrap.js'
import type { ResolutionContext } from '../config.js'
import { ConfigDefinition } from '../definition.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { REDACTED, isSecretPath, redact, secretPaths } from '../secrets.js'
import { ConfigSources } from '../sources.js'

const ctx: ResolutionContext = { profiles: ['default'] }

describe('secretPaths', () => {
  it('finds a marked leaf', () => {
    const schema = $t.Object({
      issuer: $t.String(),
      secret: $t.Secret($t.String()),
    })

    expect(secretPaths(schema)).toEqual(['secret'])
  })

  it('prefixes with the slice namespace', () => {
    const schema = $t.Object({ secret: $t.Secret($t.String()) })

    expect(secretPaths(schema, ['auth', 'schemes', 'jwt'])).toEqual(['auth.schemes.jwt.secret'])
  })

  it('descends into nested objects', () => {
    const schema = $t.Object({
      db: $t.Object({ host: $t.String(), password: $t.Secret($t.String()) }),
    })

    expect(secretPaths(schema)).toEqual(['db.password'])
  })

  // Marking the parent has to be enough, or it is a false reassurance.
  it('marks a whole object without descending into it', () => {
    const schema = $t.Object({
      credentials: $t.Secret($t.Object({ user: $t.String(), password: $t.String() })),
    })

    expect(secretPaths(schema)).toEqual(['credentials'])
  })

  it('sees through Optional', () => {
    const schema = $t.Object({ secret: $t.Optional($t.Secret($t.String())) })

    expect(secretPaths(schema)).toEqual(['secret'])
  })

  it('finds nothing in a schema that marked nothing', () => {
    expect(secretPaths($t.Object({ host: $t.String() }))).toEqual([])
  })

  // Documented limitation, not an oversight: a foreign schema exposes no shape to walk.
  it('finds nothing in a foreign Standard Schema', () => {
    expect(secretPaths(z.object({ secret: z.string() }))).toEqual([])
  })
})

describe('isSecretPath', () => {
  const secrets = new Set(['auth.secret', 'db.credentials'])

  it('matches the marked path itself', () => {
    expect(isSecretPath(secrets, 'auth.secret')).toBe(true)
  })

  it('matches anything beneath a marked path', () => {
    expect(isSecretPath(secrets, 'db.credentials.password')).toBe(true)
  })

  it('does not match a sibling or a prefix', () => {
    expect(isSecretPath(secrets, 'auth.issuer')).toBe(false)
    expect(isSecretPath(secrets, 'auth')).toBe(false)
    expect(isSecretPath(secrets, 'db')).toBe(false)
  })

  // `secretPaths` records a property named `a.b` as the single escaped segment `a\.b` (via `joinPath`). The
  // prefix probe re-encodes each ancestor the same way, so marking that object still hides its children — and
  // the two-segment key `a.b` stays a different thing from the one-segment `a\.b`.
  it('matches beneath a marked path whose segment holds a literal dot', () => {
    const dotted = new Set(['a\\.b'])

    expect(isSecretPath(dotted, 'a\\.b')).toBe(true)
    expect(isSecretPath(dotted, 'a\\.b.password')).toBe(true)
    expect(isSecretPath(dotted, 'a.b.password')).toBe(false)
  })
})

describe('redact', () => {
  // A subtree read must not walk past the escape either: the child path it rebuilds has to be the key
  // `secretPaths` wrote, or the nested value comes back in the clear.
  it('redacts a child of a marked object whose name holds a literal dot', () => {
    const secrets = new Set(['creds\\.v2'])
    const value = { 'creds.v2': { token: 'super-secret', extra: { deep: 'also-secret' } } }

    expect(redact(secrets, '', value)).toEqual({
      'creds.v2': REDACTED,
    })
    expect(redact(secrets, 'creds\\.v2.extra', { deep: 'also-secret' })).toBe(REDACTED)
  })
})

describe('diagnostics redaction', () => {
  const jwtSchema = $t.Object({
    issuer: $t.String(),
    secret: $t.Secret($t.String()),
  })

  async function bootstrapWithSlice() {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = definition.slice<{ issuer: string; secret: string }>(['auth', 'jwt'], jwtSchema)

    definition.sources.add(
      new InlineConfigProvider({
        auth: { jwt: { issuer: 'https://id.example.com', secret: 'super-secret' } },
      }),
    )

    const result = await bootstrapConfig({
      sources: definition.sources,
      schema: definition.schema,
      slices: definition.slices,
      secrets: definition.secrets,
      profiles: ctx.profiles,
    })

    return { result, slice }
  }

  it('redacts a marked value from valueAt', async () => {
    const { result } = await bootstrapWithSlice()

    expect(result.diagnostics.valueAt('auth.jwt.secret')).toBe(REDACTED)
    expect(result.diagnostics.valueAt('auth.jwt.issuer')).toBe('https://id.example.com')
  })

  // Asking one level up must not be a way around it.
  it('redacts a marked value inside a subtree read', async () => {
    const { result } = await bootstrapWithSlice()

    expect(result.diagnostics.valueAt('auth.jwt')).toEqual({
      issuer: 'https://id.example.com',
      secret: REDACTED,
    })
  })

  it('redacts the snapshot, which is the thing built to be dumped', async () => {
    const { result } = await bootstrapWithSlice()

    expect(result.diagnostics.snapshot.values.get('auth.jwt.secret')?.value).toBe(REDACTED)
    expect(result.diagnostics.snapshot.values.get('auth.jwt.issuer')?.value).toBe('https://id.example.com')
    expect(JSON.stringify([...result.diagnostics.snapshot.values])).not.toContain('super-secret')
  })

  // Where a secret came from is not the secret, and it is exactly what a debugging session needs.
  it('keeps the origin readable', async () => {
    const { result } = await bootstrapWithSlice()

    expect(result.diagnostics.originOf('auth.jwt.secret')).toMatch(/^inline/)
  })

  // The whole point: the feature still gets the real value.
  it('leaves the feature read untouched', async () => {
    const { slice } = await bootstrapWithSlice()

    expect(slice.config.secret).toBe('super-secret')
    expect(slice.config.issuer).toBe('https://id.example.com')
  })

  it('redacts a secret the application declared on its own root schema', async () => {
    const result = await bootstrapConfig({
      schema: $t.Object({ apiKey: $t.Secret($t.String()) }),
      sources: ConfigSources.of(new InlineConfigProvider({ apiKey: 'root-level-secret' })),
      profiles: ctx.profiles,
    })

    expect(result.validated.apiKey).toBe('root-level-secret')
    expect(result.diagnostics.valueAt('apiKey')).toBe(REDACTED)
  })

  it('leaves diagnostics alone when nothing was marked', async () => {
    const result = await bootstrapConfig({
      schema: $t.Object({ host: $t.String() }),
      sources: ConfigSources.of(new InlineConfigProvider({ host: 'localhost' })),
      profiles: ctx.profiles,
    })

    expect(result.diagnostics.valueAt('host')).toBe('localhost')
    expect(result.diagnostics.snapshot).toBe(result.snapshot)
  })
})
