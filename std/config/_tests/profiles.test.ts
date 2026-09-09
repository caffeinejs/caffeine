import { describe, expect, it } from 'vitest'

import { activeProfiles } from '../profiles.js'

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
