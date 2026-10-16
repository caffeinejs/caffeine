import { describe, expect, it } from 'vitest'

import { challenge, quotedString } from './challenge.js'

describe('quotedString', () => {
  it('wraps plain text in quotes', () => {
    expect(quotedString('My App')).toBe('"My App"')
    expect(quotedString('')).toBe('""')
  })

  // RFC 9110 §5.6.4: the two characters that would end or bend the string are written as quoted-pairs.
  it('escapes a quote and a backslash', () => {
    expect(quotedString('The "API"')).toBe('"The \\"API\\""')
    expect(quotedString('C:\\realm')).toBe('"C:\\\\realm"')
    expect(quotedString('\\"')).toBe('"\\\\\\""')
  })

  // Node refuses to send a header value holding any of these, so a value that kept one would make every response
  // carrying it a 500. A line break is also how a second header would be smuggled in.
  it('drops what no header value can carry', () => {
    expect(quotedString('Docs\r\nX-Injected: yes')).toBe('"DocsX-Injected: yes"')
    expect(quotedString('nul\u0000 and del\u007F')).toBe('"nul and del"')
    expect(quotedString('lock \u{1F512} snowman \u2603')).toBe('"lock  snowman "')
  })

  it('keeps a tab, and the Latin-1 range a header may carry', () => {
    expect(quotedString('a\tb')).toBe('"a\tb"')
    expect(quotedString('Área')).toBe('"Área"')
  })
})

describe('challenge', () => {
  it('is the bare scheme when it has no parameter to give', () => {
    expect(challenge('Bearer')).toBe('Bearer')
    expect(challenge('Bearer', { realm: undefined, error: undefined })).toBe('Bearer')
  })

  it('lists its parameters in the order given, leaving out the unset ones', () => {
    expect(challenge('Bearer', { realm: 'api', error: undefined, error_description: 'expired' })).toBe(
      'Bearer realm="api", error_description="expired"',
    )
    expect(challenge('Basic', { realm: '', charset: 'UTF-8' })).toBe('Basic realm="", charset="UTF-8"')
  })

  it('writes every value as a quoted-string', () => {
    expect(challenge('Basic', { realm: 'a "b"' })).toBe('Basic realm="a \\"b\\""')
  })
})
