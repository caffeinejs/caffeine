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

/** An unsafe request carrying a web Origin, with or without Fetch Metadata: what a refusal can name. */
const refusable: fc.Arbitrary<OriginCheckInput> = fc.record({
  method: fc.constant('POST'),
  secFetchSite: fc.option(site, { nil: undefined }),
  origin: fc.webUrl(),
  host: fc.domain(),
  protocol: fc.constantFrom('http', 'https'),
})

/**
 * A request from a browser too old for Fetch Metadata whose Origin is the request's own: its scheme and host, each
 * side cased at random, and a default port written out or left off on either.
 */
const ownOrigin: fc.Arbitrary<OriginCheckInput> = fc
  .record({
    host: fc.domain(),
    protocol: fc.constantFrom('http', 'https'),
    upperOrigin: fc.boolean(),
    upperHost: fc.boolean(),
    portOnOrigin: fc.boolean(),
    portOnHost: fc.boolean(),
  })
  .map(({ host, protocol, upperOrigin, upperHost, portOnOrigin, portOnHost }) => {
    const port = protocol === 'https' ? ':443' : ':80'
    const cased = (upper: boolean) => (upper ? host.toUpperCase() : host)

    return {
      method: 'POST',
      host: cased(upperHost) + (portOnHost ? port : ''),
      protocol,
      origin: `${protocol}://${cased(upperOrigin)}${portOnOrigin ? port : ''}`,
    }
  })

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

  // Case and a default port are spellings of one origin: neither may turn the request's own into a stranger.
  it.prop([ownOrigin])("never refuses an Origin that is the request's own, however it is spelled", request => {
    expect(checkOrigin(request, { trustedOrigins: new Set() })).toEqual({ verdict: 'allow', reason: 'same-origin' })
  })

  it.prop([fc.domain(), fc.option(fc.constantFrom('cross-site', 'same-site'), { nil: undefined })])(
    'refuses its own host over http: on a request known to be HTTPS, leaving nothing to ask',
    (host, secFetchSite) => {
      const request = { method: 'POST', host, protocol: 'https', origin: `http://${host}`, secFetchSite }
      const result = checkOrigin(request, { trustedOrigins: new Set() })

      expect(result.verdict).toBe('deny')
      expect(result.askable).toBeUndefined()
    },
  )

  // Trusting more can only let more through: a list that grows never refuses what a shorter one let in.
  it.prop([input, origins, origins])('never refuses a request for trusting more origins', (request, some, more) => {
    const after = checkOrigin(request, { trustedOrigins: new Set([...some, ...more]) }).verdict

    if (after === 'deny') {
      expect(checkOrigin(request, { trustedOrigins: some }).verdict).toBe('deny')
    }
  })

  // The browser's word stands for the whole request: the host only matters when it is all there is to go on.
  it.prop([input, fc.domain(), fc.domain(), origins])(
    'judges by Sec-Fetch-Site alone when a browser sent it, whatever the host',
    (request, one, other, trustedOrigins) => {
      fc.pre(request.secFetchSite !== undefined && request.secFetchSite !== '')

      expect(checkOrigin({ ...request, host: one }, { trustedOrigins })).toEqual(
        checkOrigin({ ...request, host: other }, { trustedOrigins }),
      )
    },
  )
})

describe('checkOrigin (property): what a refusal lets the application ask', () => {
  it.prop([refusable, origins])(
    'names a web origin, spelled once, and only on a refusal',
    (request, trustedOrigins) => {
      const { verdict, askable } = checkOrigin(request, { trustedOrigins })
      if (askable === undefined) {
        return
      }

      const url = new URL(askable.origin)
      expect(verdict).toBe('deny')
      expect(url.origin).toBe(askable.origin)
      expect(['http:', 'https:']).toContain(url.protocol)
      expect([undefined, 'same-site', 'cross-site']).toContain(askable.site)
    },
  )

  // What a refusal names is exactly what the application may trust: listing it lets the request through.
  it.prop([refusable, origins])('lets a request through once the origin it names is trusted', (request, trusted) => {
    const { askable } = checkOrigin(request, { trustedOrigins: trusted })
    if (askable === undefined) {
      return
    }

    expect(checkOrigin(request, { trustedOrigins: new Set([...trusted, askable.origin]) }).verdict).toBe('allow')
  })

  // And nothing the exact list could let through is withheld, but the downgrade, which the list alone may take.
  it.prop([refusable])('names the origin of every refusal that trusting it would let through', request => {
    const refused = checkOrigin(request, { trustedOrigins: new Set() })
    const origin = new URL(request.origin!).origin
    const downgrade = request.protocol === 'https' && origin.startsWith('http:')
    fc.pre(refused.verdict === 'deny' && !downgrade)

    if (checkOrigin(request, { trustedOrigins: new Set([origin]) }).verdict === 'allow') {
      expect(refused.askable?.origin).toBe(origin)
    }
  })

  it.prop([refusable])('never names an http: origin on a request known to be HTTPS', request => {
    const { askable } = checkOrigin({ ...request, protocol: 'https' }, { trustedOrigins: new Set() })

    expect(askable === undefined || askable.origin.startsWith('https:')).toBe(true)
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
