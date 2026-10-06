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
    // A label holds at most 63 characters, so a domain that long is many short labels.
    const at = (length: number) =>
      attribute === 'path' ? `/${'p'.repeat(length - 1)}` : `${'a.'.repeat(511)}${'c'.repeat(length - 1022)}`

    expect(cookieRuleViolation('id', { [attribute]: at(1024) })).toBeUndefined()
    expect(cookieRuleViolation('id', { [attribute]: at(1025) })).toMatch(/is longer than 1024 bytes$/)
  })

  // What cookie@2 refuses to write, refused before a response is due: at start-up, for the authentication schemes.
  describe('Domain and Path syntax', () => {
    it.each(['example.com', '.example.com', 'Sub.Example.COM', 'localhost', '127.0.0.1'])(
      'takes the Domain %j',
      domain => {
        expect(cookieRuleViolation('id', { domain })).toBeUndefined()
      },
    )

    it.each(['bad domain', 'a_b.com', '-a.com', 'a..com', 'a.com.', 'é.com'])('refuses the Domain %j', domain => {
      expect(cookieRuleViolation('id', { domain })).toBe('its Domain is not a valid domain name')
    })

    it.each(['/', '/a b', '/a=b', '/~user'])('takes the Path %j', path => {
      expect(cookieRuleViolation('id', { path })).toBeUndefined()
    })

    // RFC 6265bis §5.6.4: a user agent stores such a cookie at the page's own path, not at the one it names.
    it.each(['foo', 'a/b', ' /x'])('refuses the Path %j, which does not start with "/"', path => {
      expect(cookieRuleViolation('id', { path })).toBe('its Path does not start with "/"')
    })

    it.each(['/a;b', '/a<b', '/a\nb', '/a\u007Fb', '/é'])('refuses the Path %j', path => {
      expect(cookieRuleViolation('id', { path })).toBe(
        'its Path may hold only spaces and printable US-ASCII characters other than ";" and "<"',
      )
    })
  })
})
