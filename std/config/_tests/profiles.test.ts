import { describe, expect, it } from 'vitest'

import { activeProfiles, hostProfiles } from '../profiles.js'
import { ArgsConfigSource } from '../sources/args_source.js'

describe('activeProfiles', () => {
  it('passes a string array through, trimmed', () => {
    // A file or the code band already produces an array; it must survive untouched apart from whitespace.
    expect(activeProfiles(['eu', ' dev '])).toEqual(['eu', 'dev'])
  })

  it('splits delimited text so an environment variable can name several', () => {
    // `CAFFEINE_PROFILES=eu,dev` arrives as one string; without the split only "eu,dev" would be a profile.
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

  // A file source makes a file name of each profile. A name that climbs out of the directory would read a file
  // nobody configured, so it fails before anything loads.
  it('refuses a profile that is a path rather than a name', () => {
    for (const raw of [['..'], ['.'], ['a/b'], ['a\\b'], 'eu,x/../../etc']) {
      expect(() => activeProfiles(raw)).toThrow(
        expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_PROFILE' }),
      )
    }
    expect(() => activeProfiles(['x/../../etc'])).toThrow(/Cannot use profile "x\/..\/..\/etc"/)
  })

  it('accepts a name holding dots and dashes', () => {
    expect(activeProfiles(['eu-west.1', 'v1..2'])).toEqual(['eu-west.1', 'v1..2'])
  })
})

describe('hostProfiles', () => {
  const noEnv: Record<string, string | undefined> = {}

  it('reads --caffeine.profiles in both spellings', () => {
    expect(hostProfiles(['--caffeine.profiles=eu,dev'], noEnv)).toEqual(['eu', 'dev'])
    expect(hostProfiles(['--caffeine.profiles', 'eu'], noEnv)).toEqual(['eu'])
    expect(hostProfiles(['--caffeine:profiles=eu'], noEnv)).toEqual(['eu'])
  })

  it('reads CAFFEINE_PROFILES', () => {
    expect(hostProfiles([], { CAFFEINE_PROFILES: 'eu, dev' })).toEqual(['eu', 'dev'])
  })

  // `CAFFEINE__PROFILES` is how an environment source spells the configuration key `caffeine.profiles`, which
  // nothing reads. Read here too, it would name profiles through a key the rest of the framework ignores.
  it('reads nothing from CAFFEINE__PROFILES', () => {
    expect(hostProfiles([], { CAFFEINE__PROFILES: 'eu' })).toEqual([])
  })

  // A single run has to be redirectable without touching the environment it runs in — the same reason the
  // args band sits above the env band in the configuration chain.
  it('lets an argument beat the environment', () => {
    expect(hostProfiles(['--caffeine.profiles=arg'], { CAFFEINE_PROFILES: 'env' })).toEqual(['arg'])
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

  // The profiles are read before anything loads, with the parser the args source uses: whatever spelling names a
  // switch there names the profiles here.
  it('reads the flag as the args source reads the same argument', () => {
    for (const argv of [
      ['--caffeine.profiles=eu'],
      ['--caffeine:profiles', 'eu,dev'],
      ['/usr/bin/node', 'main.js', '--caffeine.profiles', 'eu', '--caffeine.profiles=dev'],
    ]) {
      const tree = new ArgsConfigSource({ argv }).load()[0].data as { caffeine: { profiles: string } }

      expect(hostProfiles(argv, noEnv)).toEqual(activeProfiles(tree.caffeine.profiles))
    }
  })

  it('normalizes exactly as a configured value would', () => {
    expect(hostProfiles(['--caffeine.profiles=eu,,eu, dev'], noEnv)).toEqual(['eu', 'dev'])
  })

  it('refuses a path from the command line and from the environment', () => {
    const refused = expect.objectContaining({ code: 'ERR_CONFIG_PROFILE' })

    expect(() => hostProfiles(['--caffeine.profiles=../secrets'], noEnv)).toThrow(refused)
    expect(() => hostProfiles([], { CAFFEINE_PROFILES: 'eu,x/../../etc' })).toThrow(refused)
  })
})
