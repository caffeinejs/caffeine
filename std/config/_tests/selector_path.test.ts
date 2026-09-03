import { describe, expect, it } from 'vitest'

import { selectorPath } from '../selector_path.js'

interface Config {
  server: { port: number }
  app: { server: { port: number } }
}

const path = (selector: (c: Config) => unknown): readonly string[] => selectorPath(selector as (c: never) => unknown)

const selectorError = expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_SELECTOR' })

describe('selectorPath', () => {
  it('records a single property', () => {
    expect(path(c => c.server)).toEqual(['server'])
  })

  it('records a nested chain', () => {
    expect(path(c => c.app.server)).toEqual(['app', 'server'])
  })

  it('records a leaf as readily as a branch', () => {
    expect(path(c => c.app.server.port)).toEqual(['app', 'server', 'port'])
  })

  it('returns pre-split segments rather than a dotted string', () => {
    const parts = path(c => c.app.server)
    expect(Array.isArray(parts)).toBe(true)
    expect(parts).not.toBe('app.server')
  })

  it('works through optional chaining', () => {
    expect(path(c => c.app?.server)).toEqual(['app', 'server'])
  })

  it('works through destructuring', () => {
    expect(path(({ app }) => app.server)).toEqual(['app', 'server'])
  })

  it('rejects a selector that builds a value instead of naming a place', () => {
    expect(() => path(c => ({ port: c.server.port }))).toThrow(selectorError)
  })

  it('rejects a selector that calls a method', () => {
    expect(() => path(c => (c.server as unknown as { toString(): string }).toString())).toThrow(selectorError)
  })

  it('rejects a selector returning the config root', () => {
    expect(() => path(c => c)).toThrow(selectorError)
  })

  it('rejects a selector returning a constant', () => {
    expect(() => path(() => 'server')).toThrow(selectorError)
  })

  it('explains itself', () => {
    expect(() => path(c => ({ port: c.server.port }))).toThrow(/plain property chain/)
  })
})
