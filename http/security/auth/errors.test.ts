import { describe, expect, it } from 'vitest'

import { ErrCaffeineWebApplication } from '../../error/common.js'
import { ErrAuthSchemeNotFound } from './errors.js'

describe('ErrAuthSchemeNotFound', () => {
  // The first line names the scheme that resolved to nothing and what was registered instead, so a typo reads as
  // one. Built without the list, it names the scheme alone.
  it.each([
    ['without the registered list', undefined, ''],
    ['with nothing registered', [], ' (no schemes are registered)'],
    ['with schemes registered', ['Bearer', 'Cookie'], ' (registered: "Bearer", "Cookie")'],
  ])('names the scheme %s', (_label, registered, suffix) => {
    const err = new ErrAuthSchemeNotFound('Beaerer', registered)

    expect(err).toBeInstanceOf(ErrCaffeineWebApplication)
    expect(err).toMatchObject({ name: 'ErrAuthSchemeNotFound', code: 'ERR_AUTH_SCHEME_NOT_FOUND' })
    expect(err.message.split('\n')[0]).toBe(
      `Cannot resolve authentication scheme "Beaerer": no handler is registered under that name${suffix}`,
    )
  })
})
