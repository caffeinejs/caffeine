import { describe, expect, it } from 'vitest'

import { ErrCSRFConfiguration } from './errors.js'
import { checkOrigin, normalizeTrustedOrigin, SAFE_METHODS, type OriginCheckInput } from './origin.js'

const NONE = { trustedOrigins: new Set<string>() }
const ADMIN = { trustedOrigins: new Set(['https://admin.example']) }

/** An unsafe request to `app.example` over HTTPS, with whatever headers the case needs. */
function post(input: Partial<OriginCheckInput> = {}): OriginCheckInput {
  return { method: 'POST', host: 'app.example', protocol: 'https', ...input }
}

describe('checkOrigin', () => {
  describe('safe methods', () => {
    // A safe method changes nothing, so there is nothing to forge: a GET from a hostile page is a link.
    it('allows a safe method whatever its headers say', () => {
      for (const method of SAFE_METHODS) {
        expect(checkOrigin(post({ method, secFetchSite: 'cross-site', origin: 'https://evil.example' }), NONE)).toEqual(
          {
            verdict: 'allow',
            reason: 'safe-method',
          },
        )
      }
    })

    it('reads the method as the request line spells it', () => {
      expect(checkOrigin(post({ method: 'get', secFetchSite: 'cross-site' }), NONE).verdict).toBe('deny')
    })
  })

  describe('with Sec-Fetch-Site', () => {
    // The header is the browser's word, which no script can forge: it decides, whatever the Origin says.
    it('allows same-origin and none, whatever the Origin says', () => {
      for (const site of ['same-origin', 'none']) {
        expect(checkOrigin(post({ secFetchSite: site, origin: 'https://evil.example' }), NONE)).toEqual({
          verdict: 'allow',
          reason: 'same-origin',
        })
      }
    })

    it('refuses cross-site', () => {
      expect(checkOrigin(post({ secFetchSite: 'cross-site', origin: 'https://evil.example' }), NONE)).toEqual({
        verdict: 'deny',
        reason: 'sec-fetch-site',
        askable: { origin: 'https://evil.example', site: 'cross-site' },
      })
    })

    // A sibling subdomain is where a cookie-tossing or a compromised blog lives: not this origin.
    it('refuses same-site', () => {
      expect(checkOrigin(post({ secFetchSite: 'same-site', origin: 'https://blog.app.example' }), NONE)).toEqual({
        verdict: 'deny',
        reason: 'sec-fetch-site',
        askable: { origin: 'https://blog.app.example', site: 'same-site' },
      })
    })

    it('refuses a value no browser writes', () => {
      for (const site of ['Same-Origin', 'whatever', 'same-origin cross-site']) {
        expect(checkOrigin(post({ secFetchSite: site, origin: 'https://app.example' }), NONE).verdict).toBe('deny')
      }
    })

    it('lets a cross-site request through from a trusted origin, on an exact match', () => {
      const from = (origin: string) => checkOrigin(post({ secFetchSite: 'cross-site', origin }), ADMIN)

      expect(from('https://admin.example')).toEqual({ verdict: 'allow', reason: 'trusted-origin' })
      expect(from('https://ADMIN.Example').verdict).toBe('allow')
      expect(from('https://admin.example:8443').verdict).toBe('deny')
      expect(from('http://admin.example').verdict).toBe('deny')
      expect(from('https://admin.example.evil').verdict).toBe('deny')
      expect(from('null').verdict).toBe('deny')
    })

    it('treats an empty header as absent', () => {
      expect(checkOrigin(post({ secFetchSite: '', origin: '' }), NONE)).toEqual({
        verdict: 'unknown',
        reason: 'no-browser-headers',
      })
    })
  })

  describe('with Origin alone', () => {
    // Every browser has sent Origin on an unsafe request since 2019: neither header is a client that is no browser.
    it('answers unknown when the request carries neither header', () => {
      expect(checkOrigin(post(), NONE)).toEqual({ verdict: 'unknown', reason: 'no-browser-headers' })
    })

    // `null` is what a sandboxed frame, a redirect across origins or a `file:` page sends: it says nothing about
    // where the request came from, which is not the same as saying it came from here.
    it('refuses Origin: null', () => {
      expect(checkOrigin(post({ origin: 'null' }), NONE)).toEqual({ verdict: 'deny', reason: 'origin-null' })
      expect(checkOrigin(post({ origin: 'null' }), ADMIN).verdict).toBe('deny')
    })

    it('refuses an Origin it cannot read as one', () => {
      for (const origin of [
        'evil',
        'app.example',
        'https://',
        'https://a.example, https://b.example',
        'chrome-extension://abc',
      ]) {
        expect(checkOrigin(post({ origin }), NONE), origin).toEqual({ verdict: 'deny', reason: 'origin-malformed' })
      }
    })

    it("allows an Origin naming the request's own host", () => {
      expect(checkOrigin(post({ origin: 'https://app.example' }), NONE)).toEqual({
        verdict: 'allow',
        reason: 'same-origin',
      })
    })

    // A host is case-insensitive, and a port the scheme implies is the same as none: `URL` takes it off the origin,
    // and a proxy may have left it on the Host header.
    it('compares hosts case-insensitively and without a default port', () => {
      expect(checkOrigin(post({ origin: 'https://App.Example', host: 'APP.EXAMPLE' }), NONE).verdict).toBe('allow')
      expect(checkOrigin(post({ origin: 'https://app.example:443' }), NONE).verdict).toBe('allow')
      expect(checkOrigin(post({ origin: 'https://app.example', host: 'app.example:443' }), NONE).verdict).toBe('allow')
      expect(
        checkOrigin(post({ origin: 'http://app.example', host: 'app.example:80', protocol: 'http' }), NONE).verdict,
      ).toBe('allow')
    })

    it('compares an IPv6 host with its port', () => {
      expect(
        checkOrigin(post({ origin: 'http://[::1]:3000', host: '[::1]:3000', protocol: 'http' }), NONE).verdict,
      ).toBe('allow')
      expect(
        checkOrigin(post({ origin: 'http://[::1]:3001', host: '[::1]:3000', protocol: 'http' }), NONE).verdict,
      ).toBe('deny')
    })

    it('refuses an Origin naming another host, or another port', () => {
      for (const origin of [
        'https://evil.example',
        'https://app.example.evil',
        'https://app.example:8443',
        'https://sub.app.example',
      ]) {
        expect(checkOrigin(post({ origin }), NONE), origin).toEqual({
          verdict: 'deny',
          reason: 'origin-mismatch',
          askable: { origin },
        })
      }
    })

    // A page's origin is `http:` or `https:`. A `ws:` origin naming this host, or a `blob:` URL answering with its
    // inner origin, is nothing a page sends, and must not read as this origin or a trusted one.
    it('refuses an Origin of a scheme no page has, even one naming this host or a trusted origin', () => {
      for (const origin of [
        'ws://app.example',
        'wss://app.example',
        'ftp://app.example',
        'blob:https://app.example/0b',
      ]) {
        expect(checkOrigin(post({ origin }), NONE), origin).toEqual({ verdict: 'deny', reason: 'origin-malformed' })
      }

      expect(checkOrigin(post({ origin: 'blob:https://admin.example/0b' }), ADMIN)).toEqual({
        verdict: 'deny',
        reason: 'origin-malformed',
      })
      // A `blob:` URL has no host: it must not match a request that names none either.
      expect(checkOrigin(post({ origin: 'blob:https://app.example/0b', host: '' }), NONE).verdict).toBe('deny')
      expect(
        checkOrigin(post({ secFetchSite: 'cross-site', origin: 'blob:https://admin.example/0b' }), ADMIN).verdict,
      ).toBe('deny')
    })

    // A request with no `Host` (HTTP/1.0) names nothing an Origin could match.
    it('refuses any Origin on a request that names no host', () => {
      expect(checkOrigin(post({ origin: 'https://app.example', host: '' }), NONE)).toMatchObject({
        verdict: 'deny',
        reason: 'origin-mismatch',
      })
    })

    it('allows a trusted Origin a browser too old for Fetch Metadata sends', () => {
      expect(checkOrigin(post({ origin: 'https://admin.example' }), ADMIN)).toEqual({
        verdict: 'allow',
        reason: 'trusted-origin',
      })
    })

    // A page over plain HTTP posting to the HTTPS site is the one downgrade the server can tell: it knows it came
    // over TLS, and `http://app.example` is another origin.
    it('refuses an http: Origin on a request the server knows came over HTTPS', () => {
      expect(checkOrigin(post({ origin: 'http://app.example', protocol: 'https' }), NONE)).toEqual({
        verdict: 'deny',
        reason: 'scheme-downgrade',
      })
    })

    // The reverse is a proxy that ended TLS and was not told to be trusted: refusing it would refuse every old
    // browser behind such a proxy, so the host alone decides, as Go does.
    it('allows an https: Origin on a request delivered over plain HTTP', () => {
      expect(checkOrigin(post({ origin: 'https://app.example', protocol: 'http' }), NONE).verdict).toBe('allow')
    })

    it('ignores a path on the Origin, which a browser never sends', () => {
      expect(checkOrigin(post({ origin: 'https://app.example/path?q#f' }), NONE).verdict).toBe('allow')
    })
  })

  // What a refusal hands the application's own checks is what they may widen on, and nothing else: an origin a page
  // could have, spelled once.
  describe('what a refusal lets the application ask', () => {
    it('names the origin as scheme://host[:port], whatever else the header carried', () => {
      const askable = (input: Partial<OriginCheckInput>) => checkOrigin(post(input), NONE).askable

      expect(askable({ secFetchSite: 'cross-site', origin: 'HTTPS://Partner.Example:443/path?q' })).toEqual({
        origin: 'https://partner.example',
        site: 'cross-site',
      })
      // The userinfo is not the host: this origin is `evil.example`.
      expect(askable({ secFetchSite: 'cross-site', origin: 'https://partner.example@evil.example' })).toEqual({
        origin: 'https://evil.example',
        site: 'cross-site',
      })
      expect(askable({ origin: 'https://partner.example:8443' })).toEqual({ origin: 'https://partner.example:8443' })
    })

    it('names the site only when it is one a browser writes for another site', () => {
      const site = (secFetchSite: string) =>
        checkOrigin(post({ secFetchSite, origin: 'https://partner.example' }), NONE).askable

      expect(site('same-site')).toEqual({ origin: 'https://partner.example', site: 'same-site' })
      expect(site('cross-site')).toEqual({ origin: 'https://partner.example', site: 'cross-site' })
      expect(site('Cross-Site')).toEqual({ origin: 'https://partner.example' })
      expect(site('cross-site, cross-site')).toEqual({ origin: 'https://partner.example' })
    })

    // `null` is what a sandboxed frame sends: nothing an application could judge, and nothing it may let through.
    it('leaves nothing to ask about an Origin that is absent, null, malformed or not a web origin', () => {
      for (const origin of [
        undefined,
        'null',
        'evil',
        'chrome-extension://abc',
        'ws://partner.example',
        'ftp://partner.example',
        'blob:https://partner.example/0b3e',
      ]) {
        expect(checkOrigin(post({ secFetchSite: 'cross-site', origin }), NONE), String(origin)).toEqual({
          verdict: 'deny',
          reason: 'sec-fetch-site',
        })
        if (origin !== undefined) {
          expect(checkOrigin(post({ origin }), NONE).askable, origin).toBeUndefined()
        }
      }
    })

    // The downgrade the rules refuse stays refused: only the exact list, where the scheme is written out, takes it.
    it('leaves nothing to ask about an http: Origin on a request known to be HTTPS', () => {
      const downgrade = { origin: 'http://partner.example', protocol: 'https' }

      expect(checkOrigin(post({ ...downgrade, secFetchSite: 'cross-site' }), NONE).askable).toBeUndefined()
      expect(checkOrigin(post({ ...downgrade, origin: 'http://app.example' }), NONE)).toEqual({
        verdict: 'deny',
        reason: 'scheme-downgrade',
      })
      expect(checkOrigin(post({ ...downgrade, protocol: 'http' }), NONE).askable).toEqual({
        origin: 'http://partner.example',
      })
    })

    it('leaves nothing to ask about a request it lets through', () => {
      expect(checkOrigin(post({ method: 'GET', origin: 'https://evil.example' }), NONE).askable).toBeUndefined()
      expect(checkOrigin(post({ origin: 'https://app.example' }), NONE).askable).toBeUndefined()
      expect(checkOrigin(post({ origin: 'https://admin.example' }), ADMIN).askable).toBeUndefined()
      expect(checkOrigin(post(), NONE).askable).toBeUndefined()
    })
  })
})

describe('normalizeTrustedOrigin', () => {
  it('spells an origin as scheme://host[:port], lower-cased and without a default port', () => {
    expect(normalizeTrustedOrigin('https://admin.example')).toBe('https://admin.example')
    expect(normalizeTrustedOrigin('https://admin.example/')).toBe('https://admin.example')
    expect(normalizeTrustedOrigin('HTTPS://Admin.Example:443')).toBe('https://admin.example')
    expect(normalizeTrustedOrigin('http://admin.example:8080')).toBe('http://admin.example:8080')
    expect(normalizeTrustedOrigin('http://[::1]:3000')).toBe('http://[::1]:3000')
  })

  // A pattern or a URL with a path is a mistake that would trust nothing, silently: refused where it was written.
  it('refuses what is not exactly an origin', () => {
    for (const text of [
      'https://admin.example/app',
      'https://admin.example?x=1',
      'https://admin.example#top',
      'https://user:secret@admin.example',
      'https://*.example',
      '*',
      'null',
      'admin.example',
      '',
    ]) {
      expect(() => normalizeTrustedOrigin(text), text).toThrow(ErrCSRFConfiguration)
    }
  })

  it('refuses a scheme other than http and https', () => {
    expect(() => normalizeTrustedOrigin('ftp://admin.example')).toThrow(ErrCSRFConfiguration)
    expect(() => normalizeTrustedOrigin('chrome-extension://abc')).toThrow(ErrCSRFConfiguration)
  })
})
