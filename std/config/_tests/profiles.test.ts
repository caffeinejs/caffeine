import { describe, expect, it } from 'vitest'

import { activeProfiles, hostProfiles } from '../profiles.js'

describe('activeProfiles', () => {
  it('passes a string array through, trimmed', () => {
    // A file or the code band already produces an array; it must survive untouched apart from whitespace.
    expect(activeProfiles(['eu', ' dev '])).toEqual(['eu', 'dev'])
  })

  it('splits delimited text so an environment variable can name several', () => {
    // `CAFFEINE__PROFILES=eu,dev` arrives as one string; without the split only "eu,dev" would be a profile.
    expect(activeProfiles('eu, dev')).toEqual(['eu', 'dev'])
  })

  it('drops blank entries rather than letting an empty profile through', () => {
    expect(activeProfiles(['eu', '', ' ', 'dev'])).toEqual(['eu', 'dev'])
  })

  it('keeps the first position of a repeated profile so no provider sees a duplicate', () => {
    // The context is meant to be unique; a duplicate would make a file provider read the same overlay twice.
    expect(activeProfiles(['eu', 'dev', 'eu'])).toEqual(['eu', 'dev'])
  })

  it('is empty for a value that is neither a string nor an array', () => {
    expect(activeProfiles(undefined)).toEqual([])
    expect(activeProfiles(null)).toEqual([])
    expect(activeProfiles(42)).toEqual([])
  })
})

describe('hostProfiles', () => {
  const noEnv: Record<string, string | undefined> = {}

  it('reads --caffeine.profiles in both spellings', () => {
    expect(hostProfiles(['--caffeine.profiles=eu,dev'], noEnv)).toEqual(['eu', 'dev'])
    expect(hostProfiles(['--caffeine.profiles', 'eu'], noEnv)).toEqual(['eu'])
    expect(hostProfiles(['--caffeine:profiles=eu'], noEnv)).toEqual(['eu'])
  })

  it('reads CAFFEINE__PROFILES', () => {
    expect(hostProfiles([], { CAFFEINE__PROFILES: 'eu, dev' })).toEqual(['eu', 'dev'])
  })

  // A single run has to be redirectable without touching the environment it runs in — the same reason the
  // args band sits above the env band in the configuration chain.
  it('lets an argument beat the environment', () => {
    expect(hostProfiles(['--caffeine.profiles=arg'], { CAFFEINE__PROFILES: 'env' })).toEqual(['arg'])
  })

  it('names nothing when neither says anything', () => {
    expect(hostProfiles([], noEnv)).toEqual([])
    // Exactly one flag is matched, so a process carrying switches meant for something else contributes none.
    expect(hostProfiles(['--reporter=dot', '--watch'], noEnv)).toEqual([])
  })

  it('ignores a bare flag with nothing usable after it', () => {
    expect(hostProfiles(['--caffeine.profiles'], noEnv)).toEqual([])
    expect(hostProfiles(['--caffeine.profiles', '--other'], noEnv)).toEqual([])
  })

  it('stops at the argument terminator', () => {
    expect(hostProfiles(['--', '--caffeine.profiles=eu'], noEnv)).toEqual([])
  })

  it('normalizes exactly as a configured value would', () => {
    expect(hostProfiles(['--caffeine.profiles=eu,,eu, dev'], noEnv)).toEqual(['eu', 'dev'])
  })
})
