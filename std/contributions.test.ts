import { describe, expect, it } from 'vitest'
import {
  Contributions,
  ErrContributionConflict,
  ErrContributionPhase,
  ErrNoContribution,
  contributionKey,
} from './contributions.js'

interface Serverish {
  port: number
}

const kServer = contributionKey<Serverish>('test:server')
const kOther = contributionKey<string>('test:other')

const sealed = (fill: (c: Contributions) => void = () => undefined): Contributions => {
  const contributions = new Contributions()
  fill(contributions)
  contributions.seal()
  return contributions
}

describe('Contributions', () => {
  it('hands back what was contributed, typed by the key', () => {
    const contributions = sealed(c => c.contribute(kServer, { port: 8080 }))

    const server = contributions.get(kServer)

    expect(server.port).toBe(8080)
  })

  it('rejects a second contribution for the same key', () => {
    const contributions = new Contributions()
    contributions.contribute(kServer, { port: 8080 })

    expect(() => contributions.contribute(kServer, { port: 9090 })).toThrow(ErrContributionConflict)
    expect(() => contributions.contribute(kServer, { port: 9090 }))
      .toThrow('Cannot contribute "test:server": a contribution for that key already exists')
  })

  // The reason the phase exists: services bootstrap concurrently, so a read here would be answered by
  // whichever service happened to be scheduled first.
  it('refuses every read before the step is sealed', () => {
    const contributions = new Contributions()
    contributions.contribute(kServer, { port: 8080 })

    expect(() => contributions.get(kServer)).toThrow(ErrContributionPhase)
    expect(() => contributions.find(kServer)).toThrow(ErrContributionPhase)
    expect(() => contributions.has(kServer)).toThrow(ErrContributionPhase)
    expect(() => contributions.get(kServer))
      .toThrow('Cannot read contribution "test:server": contributions are not sealed yet')
  })

  it('refuses a contribution once the step is sealed', () => {
    const contributions = sealed()

    expect(() => contributions.contribute(kServer, { port: 8080 })).toThrow(ErrContributionPhase)
    expect(() => contributions.contribute(kServer, { port: 8080 }))
      .toThrow('Cannot contribute "test:server": contributions are already sealed')
  })

  it('throws on get for a key nothing contributed, and reports absence through find/has', () => {
    const contributions = sealed(c => c.contribute(kServer, { port: 8080 }))

    expect(() => contributions.get(kOther)).toThrow(ErrNoContribution)
    expect(() => contributions.get(kOther))
      .toThrow('Cannot resolve contribution "test:other": nothing contributed it')
    expect(contributions.find(kOther)).toBeUndefined()
    expect(contributions.has(kOther)).toBe(false)
    expect(contributions.has(kServer)).toBe(true)
  })

  // A contributed `undefined` is a value, not an absence — otherwise `get` would report "nothing contributed
  // it" for a key that was.
  it('tells a contributed undefined apart from nothing contributed', () => {
    const kMaybe = contributionKey<string | undefined>('test:maybe')
    const contributions = sealed(c => c.contribute(kMaybe, undefined))

    expect(contributions.has(kMaybe)).toBe(true)
    expect(contributions.get(kMaybe)).toBeUndefined()
  })

  it('reports whether it is sealed', () => {
    const contributions = new Contributions()

    expect(contributions.sealed).toBe(false)
    contributions.seal()
    expect(contributions.sealed).toBe(true)
  })

  it('keeps the value type attached to the key', () => {
    const contributions = sealed(c => c.contribute(kServer, { port: 8080 }))

    // @ts-expect-error the key holds a ServerLike, not a string
    contributions.get<string>(kServer)
    // @ts-expect-error a key without a type argument is unusable
    contributionKey('test:untyped') satisfies symbol

    expect(contributions.get(kServer)).toEqual({ port: 8080 })
  })
})
