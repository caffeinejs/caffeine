import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { checkOrigin, normalizeTrustedOrigin, SAFE_METHODS, type OriginCheckInput } from './origin.js'

const site = fc.constantFrom('same-origin', 'none', 'cross-site', 'same-site')
const header = fc.option(fc.oneof(fc.string(), fc.webUrl(), site, fc.constant('null')), { nil: undefined })
const unsafe = fc.oneof(fc.constantFrom('POST', 'PUT', 'PATCH', 'DELETE'), fc.string({ minLength: 1 }))
const method = fc.oneof(fc.constantFrom(...SAFE_METHODS), unsafe)

const input: fc.Arbitrary<OriginCheckInput> = fc.record({
  method,
  secFetchSite: header,
  origin: header,
  host: fc.oneof(fc.domain(), fc.string()),
  protocol: fc.constantFrom('http', 'https', ''),
})

/** Origins as a trusted list spells them. */
const origins = fc.array(fc.webUrl()).map(urls => new Set(urls.map(url => new URL(url).origin)))

describe('checkOrigin (property)', () => {
  it.prop([input, origins])('never throws, and always answers one of the three verdicts', (request, trustedOrigins) => {
    const { verdict } = checkOrigin(request, { trustedOrigins })

    expect(['allow', 'deny', 'unknown']).toContain(verdict)
  })

  it.prop([input, fc.constantFrom(...SAFE_METHODS)])(
    'allows a safe method whatever else the request carries',
    (request, safe) => {
      expect(checkOrigin({ ...request, method: safe }, { trustedOrigins: new Set() }).reason).toBe('safe-method')
    },
  )

  it.prop([input, fc.constantFrom('same-origin', 'none')])(
    "allows the browser's own word of a same-origin request, whatever the Origin says",
    (request, secFetchSite) => {
      expect(checkOrigin({ ...request, secFetchSite }, { trustedOrigins: new Set() }).verdict).toBe('allow')
    },
  )

  it.prop([input, origins])(
    'lets a cross-site request through only from a trusted origin',
    (request, trustedOrigins) => {
      const result = checkOrigin({ ...request, method: 'POST', secFetchSite: 'cross-site' }, { trustedOrigins })

      if (result.verdict === 'allow') {
        expect(result.reason).toBe('trusted-origin')
        expect(trustedOrigins.has(new URL(request.origin!).origin)).toBe(true)
      } else {
        expect(result.verdict).toBe('deny')
      }
    },
  )

  it.prop([input])('answers unknown exactly when the request carries neither header', request => {
    const { verdict } = checkOrigin({ ...request, method: 'POST' }, { trustedOrigins: new Set() })
    const bare = !request.secFetchSite && !request.origin

    expect(verdict === 'unknown').toBe(bare)
  })

  // What a browser never sends with its Origin cannot change the answer, or a client could spell its way past the
  // host comparison.
  it.prop([fc.webUrl(), input])('is indifferent to the path, query and fragment of an Origin', (url, request) => {
    const base = { ...request, method: 'POST', secFetchSite: undefined }
    const trustedOrigins = new Set<string>()

    expect(checkOrigin({ ...base, origin: url }, { trustedOrigins })).toEqual(
      checkOrigin({ ...base, origin: new URL(url).origin }, { trustedOrigins }),
    )
  })
})

describe('normalizeTrustedOrigin (property)', () => {
  it.prop([fc.webUrl()])('spells any origin once', url => {
    const origin = new URL(url).origin
    const normalized = normalizeTrustedOrigin(origin)

    expect(normalized).toBe(origin)
    expect(normalizeTrustedOrigin(normalized)).toBe(normalized)
  })

  it.prop([fc.webUrl({ withQueryParameters: true, withFragments: true })])(
    'refuses a URL that is more than its origin',
    url => {
      fc.pre(url !== `${new URL(url).origin}/` && url !== new URL(url).origin)

      expect(() => normalizeTrustedOrigin(url)).toThrow()
    },
  )
})
