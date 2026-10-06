import { describe, expect, it } from 'vitest'

import { cookieRuleViolation, type CookieAttributes } from './rules.js'

const hostScoped: CookieAttributes = { secure: true, httpOnly: true, path: '/' }

// Each refusal stands for a cookie a browser drops without a word: what the server meant to set is simply not there.
describe('cookieRuleViolation', () => {
  it('finds nothing wrong with a plain cookie', () => {
    expect(cookieRuleViolation('theme', { path: '/', sameSite: 'lax' })).toBeUndefined()
  })

  describe('names', () => {
    it('refuses a nameless cookie, which RFC 6265bis forbids a server to send', () => {
      expect(cookieRuleViolation('', {})).toBe('a cookie needs a name')
    })

    it.each(['a b', 'a;b', 'a=b', 'é', 'a\nb'])('refuses %j, which a header cannot carry', name => {
      expect(cookieRuleViolation(name, {})).toMatch(/^its name may hold only/)
    })
  })

  // User agents match prefixes whatever their case (RFC 6265bis §5.4), so `__host-` binds as `__Host-` does.
  describe('prefixes', () => {
    const cases: Array<[prefix: string, needs: CookieAttributes, refusals: CookieAttributes[]]> = [
      ['__Secure-', { secure: true }, [{ secure: false }, {}]],
      [
        '__Host-',
        { secure: true, path: '/' },
        [
          { secure: false, path: '/' },
          { secure: true, path: '/app' },
          { secure: true, path: '/', domain: 'example.com' },
          { secure: true },
        ],
      ],
      ['__Http-', { secure: true, httpOnly: true }, [{ secure: true }, { httpOnly: true }]],
      [
        '__Host-Http-',
        hostScoped,
        [
          { secure: true, path: '/' },
          { ...hostScoped, domain: 'example.com' },
          { ...hostScoped, path: '/app' },
        ],
      ],
    ]

    for (const [prefix, needs, refusals] of cases) {
      for (const name of [`${prefix}id`, `${prefix.toLowerCase()}id`, `${prefix.toUpperCase()}id`]) {
        it(`lets ${name} through with what it needs`, () => {
          expect(cookieRuleViolation(name, needs)).toBeUndefined()
        })

        it.each(refusals)(`refuses ${name} with %j`, attributes => {
          expect(cookieRuleViolation(name, attributes)).toContain(`"${prefix}" cookie needs`)
        })
      }
    }
  })

  it.each(['none', 'None', 'NONE'])('refuses SameSite=%s without Secure', sameSite => {
    expect(cookieRuleViolation('id', { sameSite: sameSite as 'none' })).toBe('SameSite=None needs Secure')
    expect(cookieRuleViolation('id', { sameSite: sameSite as 'none', secure: true })).toBeUndefined()
  })

  // CHIPS: a partitioned cookie is only ever a Secure one.
  it('refuses Partitioned without Secure', () => {
    expect(cookieRuleViolation('id', { partitioned: true })).toBe('Partitioned needs Secure')
    expect(cookieRuleViolation('id', { partitioned: true, secure: true })).toBeUndefined()
  })

  // RFC 6265bis §5.6: a user agent ignores an attribute value longer than 1024 octets.
  it.each(['domain', 'path'] as const)('refuses a %s longer than 1024 bytes', attribute => {
    const at = (length: number) =>
      attribute === 'path' ? `/${'p'.repeat(length - 1)}` : `${'d'.repeat(length - 4)}.com`

    expect(cookieRuleViolation('id', { [attribute]: at(1024) })).toBeUndefined()
    expect(cookieRuleViolation('id', { [attribute]: at(1025) })).toMatch(/is longer than 1024 bytes$/)
  })
})
