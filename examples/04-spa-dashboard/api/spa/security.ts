import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTPPlugin, type HTTPSetupContext } from '@caffeinejs/http'
import type { NodeContextPlatform } from '@caffeinejs/http/node'
import helmet from 'helmet'

/**
 * Helmet's defaults already suit this application: `script-src 'self'` covers the module bundle, `style-src`
 * covers the stylesheet, and a same-origin `fetch` falls through to `default-src 'self'`. The directives below
 * are stated rather than inherited so the policy is readable, and two defaults are turned off because this
 * demo runs over plain http, where `upgrade-insecure-requests` would rewrite every subresource to `https:` on
 * any host that is not localhost, and HSTS would be a footgun rather than a protection. Behind TLS, drop both
 * overrides.
 */
const headers = helmet({
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

/**
 * Security headers, written by `helmet`'s Node middleware on every response.
 *
 * `@caffeinejs/http` ships no wrapper for `helmet`, by design — security headers are the application's to choose,
 * exactly like CORS. Cross-origin protection, on the other hand, is the framework's own `csrf()`, registered in
 * `app.ts`.
 *
 * It runs from an `onRequest` hook rather than through `app.use(...)`: the authentication gate is a plugin's
 * `onRequest` hook too, plugin hooks run in the order the plugins are installed, and every one of them runs before
 * the middleware chain. Installed **before** `.with(authentication())` in `app.ts`, the headers are written ahead
 * of the gate, which is what puts them on a 401.
 */
export class SecurityHeaders extends HTTPPlugin {
  override readonly name = 'security-headers'

  register({ app }: HTTPSetupContext): void {
    app.hook('onRequest', ctx => {
      const platform = ctx.platform as { name: string }
      if (platform.name !== 'node') {
        return
      }

      const { incoming, outgoing } = platform as NodeContextPlatform
      // helmet types the HTTP/1 classes, and only calls `setHeader`, which HTTP/2's compatibility response has too.
      headers(incoming as IncomingMessage, outgoing as ServerResponse, err => {
        if (err) {
          throw err
        }
      })
    })
  }
}
