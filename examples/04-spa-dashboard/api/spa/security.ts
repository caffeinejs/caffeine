import type { HTTPPluginFactory } from '@caffeinejs/http'
import helmet from '@fastify/helmet'

/**
 * Security headers, through the one official Fastify plugin this application registers itself.
 *
 * `@caffeinejs/http` ships no wrapper for `@fastify/helmet`, by design — security headers are the application's to
 * choose, exactly like CORS and compression. Cross-origin protection, on the other hand, is the framework's own
 * `csrf()`, registered in `app.ts`.
 *
 * `securityHeaders` hands `helmet` back *with* its options: `@fastify/helmet` already wraps itself in
 * `fastify-plugin`, so registering it directly is what puts its hooks on every route, and a wrapper written only
 * to carry the options would take an encapsulation context of its own and cover nothing.
 *
 * Installed **before** the authentication gate, `.with(authentication())`, in `app.ts`. Hook *coverage* does not
 * depend on order — Fastify binds route contexts at `preReady` — but hook *execution* does, and a hook registered
 * after the authentication gate never runs for a request the gate rejected. Registering first is what puts the
 * security headers on a 401.
 */

/**
 * Helmet's defaults already suit this application: `script-src 'self'` covers the module bundle, `style-src`
 * covers the stylesheet, and a same-origin `fetch` falls through to `default-src 'self'`. The directives below
 * are stated rather than inherited so the policy is readable, and two defaults are turned off because this
 * demo runs over plain http, where `upgrade-insecure-requests` would rewrite every subresource to `https:` on
 * any host that is not localhost, and HSTS would be a footgun rather than a protection. Behind TLS, drop both
 * overrides.
 *
 * The annotation is load-bearing: it is what types the pair as a pair. Without it the array literal widens to
 * `(plugin | options)[]`, since nothing at this point contextually types the return.
 */
export const securityHeaders: HTTPPluginFactory = () => [
  helmet,
  {
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
  },
]
