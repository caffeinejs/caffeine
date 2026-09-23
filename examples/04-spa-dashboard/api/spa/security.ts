import csrfProtection from '@fastify/csrf-protection'
import helmet from '@fastify/helmet'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

/**
 * The two official Fastify plugins this application registers itself.
 *
 * `@caffeinejs/http` ships no wrapper for either, by design — security headers and CSRF are the application's
 * to choose, exactly like CORS and compression. `.with(...)` takes a factory returning a plugin and registers
 * it with no options argument, so the options are closed over here.
 *
 * The outer `fastify-plugin` is not decoration: without it the wrapper gets its own encapsulation context,
 * and since both plugins declare `skip-override` their hooks and decorators would stay inside it and reach no
 * routes at all.
 *
 * Both are installed **before** `.authentication(...)` in `app.ts`. Hook *coverage* does not depend on order —
 * Fastify binds route contexts at `preReady` — but hook *execution* does, and a hook registered after the
 * authentication gate never runs for a request the gate rejected. Registering first is what puts the security
 * headers on a 401 and checks CSRF before a forged request reaches the auth path.
 */

/**
 * Security headers.
 *
 * Helmet's defaults already suit this application: `script-src 'self'` covers the module bundle, `style-src`
 * covers the stylesheet, and a same-origin `fetch` falls through to `default-src 'self'`. The directives below
 * are stated rather than inherited so the policy is readable, and two defaults are turned off because this
 * demo runs over plain http, where `upgrade-insecure-requests` would rewrite every subresource to `https:` on
 * any host that is not localhost, and HSTS would be a footgun rather than a protection. Behind TLS, drop both
 * overrides.
 */
export const securityHeaders = () =>
  fp(
    async instance => {
      await instance.register(helmet, {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'script-src': ["'self'"],
            'style-src': ["'self'"],
            'img-src': ["'self'", 'data:'],
            'connect-src': ["'self'"],
            'manifest-src': ["'self'"],
            'frame-ancestors': ["'none'"],
            'upgrade-insecure-requests': null,
          },
        },
        strictTransportSecurity: false,
      })
    },
    { name: 'security-headers' },
  )

/** Methods that change nothing, so nothing to forge. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF, on top of the session cookie's `SameSite=Lax` rather than instead of it.
 *
 * `Lax` is a browser control and covers the common case, but it is scoped to the *site* rather than the
 * origin — a sibling subdomain is same-site — it exempts top-level `GET` navigations, and it does nothing in a
 * client that does not enforce it. So unsafe methods carry a token as well.
 *
 * `getToken` is narrowed to one header on purpose. The default also reads `body._csrf`, which would force the
 * check onto `preValidation` so the body is parsed first; reading a header keeps it on `onRequest`, before the
 * request has cost anything.
 *
 * `cookieOpts` **replaces** the plugin's defaults rather than extending them, so the sensible ones are
 * restated here. `signed` is why `app.ts` gives the cookie plugin a secret.
 */
export const csrf = () =>
  fp(
    async instance => {
      await instance.register(csrfProtection, {
        cookieOpts: { path: '/', sameSite: 'strict', httpOnly: true, signed: true },
        getToken: (req: FastifyRequest) => req.headers['x-csrf-token'] as string | undefined,
      })

      // `csrfProtection` is a plain (req, reply, done) hook with no lifecycle stage of its own and no method
      // filter — attached as-is it would reject every GET, the shell included.
      instance.addHook('onRequest', function (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
        if (SAFE.has(req.method)) {
          done()
          return
        }

        instance.csrfProtection(req, reply, done)
      })
    },
    { name: 'csrf' },
  )
