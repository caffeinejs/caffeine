import { describe, expect, it } from 'vitest'

import { FIELD_VALUE, HEADER_NAME, isHopByHop } from './header_fields.js'

describe('header names', () => {
  it('accepts an HTTP token with mixed case and token punctuation', () => {
    expect(HEADER_NAME.test("X-Value_9!#$%&'*+.^`|~")).toBe(true)
  })

  it.each(['', 'x custom', 'content-type:', 'x-header\r\n', 'café'])('refuses %j', name => {
    expect(HEADER_NAME.test(name)).toBe(false)
  })
})

describe('header field values', () => {
  it.each(['', '\t a~\x80\xff '])('accepts %j', value => {
    expect(FIELD_VALUE.test(value)).toBe(true)
  })

  it.each(['a\r\nb', 'a\n', '\x00', '\x1f', '\x7f', '\u0100'])('refuses %j', value => {
    expect(FIELD_VALUE.test(value)).toBe(false)
  })
})

describe('connection-specific fields', () => {
  it.each([
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authenticate',
  ])('recognizes %s', name => {
    expect(isHopByHop(name)).toBe(true)
  })

  it.each(['content-type', 'Connection'])('does not recognize %s', name => {
    expect(isHopByHop(name)).toBe(false)
  })
})
