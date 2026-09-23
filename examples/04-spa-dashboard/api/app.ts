import type { Container } from '@caffeinejs/di'
import { createWebApplication, health } from '@caffeinejs/http'
import { openapi } from '@caffeinejs/openapi'
import type { Logger } from '@caffeinejs/std/logger'

import { SESSION_COOKIE, configuration } from './app.config.js'
import { createLogger } from './app.log.js'
import { authRouter } from './auth/index.js'
import { projectsRouter } from './projects/index.js'
import { adminPages, apiMisses, csrf, memberPages, publicPages, securityHeaders, site } from './spa/index.js'

export interface BuildAppOptions {
  /** The application logger, or `false` for a silent one. Tests pass `false`. */
  logger?: Logger | false
}

/**
 * Builds the application from a given container — it never creates one, so a test can hand over a
 * `TestContainer` with overridden dependencies.
 *
 * The return type is deliberately inferred rather than annotated `WebApplication`: mounting a router re-types
 * the application with that router's routes, and an annotation would erase them.
 */
export function buildApp(container: Container, options: BuildAppOptions = {}) {
  return (
    createWebApplication({
      container,
      config: configuration(),
      logger: options.logger ?? createLogger(),
    })
      // --- Settings. These configure builders the constructor already registered, so where they are written
      // makes no difference to install order.
      .server(({ config }) => ({ listener: config.server }))
      .logger((b, { config }) => b.level(config.log.level))
      // The CSRF plugin signs its own cookie, and `signedCookie()` has nothing to verify with otherwise. The
      // session cookie does not need this — it seals itself.
      .cookie((c, { config }) => c.secret(config.auth.cookieSecret))
      .shutdown(s => {
        if (process.env.VITEST !== undefined) {
          s.drainDelay(0).shutdownTimeout(200)
        } else {
          s.drainDelay('5s')
        }
      })

      // --- Installs, in the order they register.
      //
      // Both plugins go ahead of the authentication gate on purpose: a hook registered after it never runs for
      // a request the gate rejected, so this is what puts the security headers on a 401 and checks CSRF before
      // a forged request reaches the auth path at all.
      .with(securityHeaders)
      .with(csrf)

      // One scheme for the whole application — pages and API alike. The session cookie is an encrypted JWT,
      // HttpOnly, so no token is ever in JavaScript; the browser attaches it to same-origin `fetch` itself.
      //
      // `challenge` and `forbid` both answer a browser navigation with a redirect and everything else with a
      // status, which is exactly the split a single-page application and its API need from one scheme.
      .authentication((auth, { config }) =>
        auth
          .addCookie(o =>
            o
              .sessionSecret(config.auth.sessionSecret)
              .cookieName(SESSION_COOKIE)
              // Plain http in the demo; a Secure cookie would never come back. Turn on behind TLS.
              .secure(config.auth.secureCookie)
              .sameSite('lax')
              .loginPath('/login')
              .accessDeniedPath('/forbidden'),
          )
          // Binds CredentialsService and a fallback ScryptPasswordHasher. The UserProvider it resolves is
          // `auth/users.ts`, which the module graph provides — there is no explicit binding anywhere.
          .addCredentials(),
      )
      // A route that declares nothing is gated. The route somebody forgets is the safe one.
      .authorization(z => z.requireAuthenticatedByDefault())

      .with(site)
      .with(
        openapi(o =>
          o
            .version('3.1.1')
            .info({
              title: 'Caffeine SPA Dashboard',
              version: '1.0.0',
              description: 'The API behind the single-page application served from the same origin.',
            })
            // Relative on purpose: a consumer resolves it against wherever it fetched the document, so it is
            // right at any host or port, and "Try it" stays on this origin — which is what lets the browser
            // attach the session cookie at all.
            .server('/', 'This server')
            // The document describes an API nobody may call anonymously, so it is not served anonymously
            // either. Without this the fallback policy would still gate it, but only by accident of it being
            // a route like any other; saying it here is what silences the start-up warning and what puts the
            // scheme into `components.securitySchemes`.
            .secure('Cookie'),
        ),
      )
      .with(health())

      // Order within `mount` does not decide matching — find-my-way prefers the longer static prefix — but
      // reading it API-first, then client routes, matches how the application is thought about.
      .mount(authRouter, projectsRouter, apiMisses, publicPages, memberPages, adminPages)
  )
}

/** The application's type, routes included. */
export type SPADashboardApp = ReturnType<typeof buildApp>
