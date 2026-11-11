import { describe, expect, it } from 'vitest'

import { statusPhrase } from './status.js'

describe('statusPhrase', () => {
  // A problem's default title and an OpenAPI description read these, so a client sees the names RFC 9110 gives.
  it.each([
    [413, 'Content Too Large'],
    [422, 'Unprocessable Content'],
  ])('names %i as RFC 9110 does, where Node keeps the older phrase', (status, phrase) => {
    expect(statusPhrase(status)).toBe(phrase)
  })

  it('names every other status as Node does', () => {
    expect(statusPhrase(404)).toBe('Not Found')
    expect(statusPhrase(418)).toBe("I'm a Teapot")
  })

  // Each caller keeps its own fallback: a problem's title reads "Unknown Error", an OpenAPI description "Response".
  it('has no phrase for a status nobody named', () => {
    expect(statusPhrase(599)).toBe(undefined)
  })
})
