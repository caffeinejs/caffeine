import { describe, expect, it } from 'vitest'
import { createConfigDiagnostics } from '../diagnostics.js'
import type { ConfigEntry, ConfigSnapshot } from '../types.js'

function makeSnapshot(data: Record<string, { value: unknown, origin: string }>): ConfigSnapshot {
  const values = new Map<string, ConfigEntry>(
    Object.entries(data).map(([k, v]) => [k, { key: k, value: v.value as never, origin: v.origin }]),
  )
  return { sources: [], values }
}

interface TestConfig {
  db: { host: string, port: number }
}

describe('ConfigDiagnostics', () => {
  const validated: TestConfig = { db: { host: 'localhost', port: 5432 } }
  const snapshot = makeSnapshot({
    'db.host': { value: 'localhost', origin: 'env:DB_HOST' },
    'db.port': { value: 5432, origin: 'file:config.json' },
  })
  const diagnostics = createConfigDiagnostics(validated, snapshot)

  it('originOf returns source for known key', () => {
    expect(diagnostics.originOf('db.host')).toBe('env:DB_HOST')
    expect(diagnostics.originOf('db.port')).toBe('file:config.json')
  })

  it('originOf returns undefined for unknown key', () => {
    expect(diagnostics.originOf('missing.key')).toBeUndefined()
  })

  it('valueAt returns nested value', () => {
    expect(diagnostics.valueAt('db.host')).toBe('localhost')
    expect(diagnostics.valueAt('db.port')).toBe(5432)
  })

  it('valueAt returns undefined for missing path', () => {
    expect(diagnostics.valueAt('db.missing')).toBeUndefined()
  })

  it('snapshot is accessible', () => {
    expect(diagnostics.snapshot).toBe(snapshot)
  })
})
