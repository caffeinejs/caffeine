import { fileURLToPath } from 'node:url'

import type { Container } from '@caffeinejs/di'
import { html } from '@caffeinejs/html'
import { Claim, Identity, Principal, createWebApplication, health } from '@caffeinejs/http'
import { multipartPlugin } from '@caffeinejs/multipart'
import { openapi } from '@caffeinejs/openapi'
import { staticFiles } from '@caffeinejs/static'
import type { Logger } from '@caffeinejs/std/logger'

import { GITHUB_SESSION_COOKIE, GITHUB_STATE_COOKIE, configuration } from './app.config.js'
import { createLogger } from './app.log.js'
import { inventoriesRouter } from './inventories/index.js'
import { ordersRouter } from './orders/index.js'
import { APIErrorSchema, FallbackErrorHandler, HTTPErrorHandler } from './util/errors/index.js'

const GITHUB_ISSUER = 'https://github.com'
const publicRoot = fileURLToPath(new URL('../public', import.meta.url))

export interface BuildAppOptions {
  /** The application logger, or `false` for a silent one. Tests pass `false`. */
  logger?: Logger | false
}

/**
 * Builds the web application from a given container — it never creates one, so tests can pass a
 * `TestContainer` with overridden dependencies. DB-agnostic: no prisma import here. Health indicators are
 * container-managed; `DatabaseHealth` is discovered through the `HealthIndicator` key.
 *
 * The return type is deliberately inferred rather than annotated `WebApplication`: mounting a router re-types
 * the application with that router's routes, and an annotation would erase them — which is exactly what a
 * typed client reads.
 */
export function buildApp(container: Container, options: BuildAppOptions = {}) {
  return (
    createWebApplication({
      container,
      config: configuration(),
      logger: options.logger ?? createLogger(),
    })
      // --- Settings. These configure builders the constructor already registered, so where they are written
      // makes no difference to install order; they are grouped first because they read as configuration.

      // Server host/port come from PETSTORE_SERVER__HOST / PETSTORE_SERVER__PORT (defaults in the schema).
      .server(({ config }) => ({ listener: config.server }))
      // The two handlers that render every thrown error: HTTPErrorHandler for an ErrHTTP, FallbackErrorHandler
      // for a validation failure or anything unexpected. Declaring them is not enough — this is what puts them
      // in front of the whole application.
      .errorHandling(e => e.globalHandlers(HTTPErrorHandler, FallbackErrorHandler))
      // The level follows configuration; the adapter builds Fastify on this logger, so the server follows it too.
      .logger((b, { config }) => b.level(config.log.level))
      // Graceful shutdown: SIGTERM makes /readyz answer 503 immediately, the drain delay covers the
      // routing-table lag while requests keep being served normally, and only then does the server close. No
      // preStop sleep in the manifest. Signals are on by default.
      //
      // Tests never need the 25s production shutdown budget; a hung Fastify close would sit on it until
      // hookTimeout. shutdownTimeout(0) waits forever — a small positive budget still force-tears down.
      .shutdown(s => {
        if (process.env.VITEST !== undefined) {
          s.drainDelay(0).shutdownTimeout(200)
        } else {
          s.drainDelay('5s')
        }
      })

      // --- Installs, in the order they register. The authentication gate has no slot of its own: it lands
      // exactly here, which is why it is written first — nothing reading `req.user` registers ahead of it.
      .authentication((auth, { config }) =>
        auth
          // Basic, for the API documentation only. Demo credentials, overridable from the environment.
          .addBasic('Basic', o =>
            o
              .realm('Petstore docs')
              .validate((_ctx, username, password) =>
                username === config.docs.user && password === config.docs.password
                  ? new Principal(true, [new Identity('Basic', true, [new Claim('sub', username, 'petstore')])])
                  : null,
              ),
          )
          // GitHub OAuth 2.0 browser login, and the application default: every route that does not name a
          // scheme authenticates with it. Two routes come with it: the callback, from callbackURL, and the one
          // that starts a sign-in, at loginPath. includeEmail fetches the verified primary email (adds the
          // user:email scope).
          .addGithub(
            'GitHub',
            o =>
              o
                .clientID(config.auth.github.clientId)
                .clientSecret(config.auth.github.clientSecret)
                .callbackURL(config.auth.github.callbackUrl)
                .sessionSecret(config.auth.github.sessionSecret)
                .sessionCookieName(GITHUB_SESSION_COOKIE)
                .stateCookieName(GITHUB_STATE_COOKIE)
                .defaultRedirectPath('/dashboard')
                // Where the homepage's "Sign in" button points, and what a 401 names in `location`: going there
                // starts the round trip to GitHub and comes back to `returnTo`, or to the dashboard without one.
                .loginPath('/login/github')
                // Nothing of GitHub's /user body becomes a claim unless it is named, and a role least of all: the
                // body is unsigned, and much of it is whatever the user typed into their profile. Granting a role
                // therefore takes a mapper, which also replaces the preset's own mapping — so it names the few
                // fields the app renders, and keeps the sealed session cookie well under a browser's ~4 KB.
                .claimMapper(u => {
                  const claims = [
                    // GitHub's id is a number; a subject is a string wherever it is read.
                    new Claim('sub', String(u.id), GITHUB_ISSUER),
                    new Claim('login', u.login, GITHUB_ISSUER),
                    new Claim('name', u.name ?? u.login, GITHUB_ISSUER),
                  ]
                  if (u.email) {
                    claims.push(new Claim('email', u.email, GITHUB_ISSUER))
                  }
                  if (u.avatar_url) {
                    claims.push(new Claim('avatar_url', u.avatar_url, GITHUB_ISSUER))
                  }
                  // Grants every signed-in GitHub user the scope the pet write routes gate on. A real deployment
                  // would map this from an org/team membership; stated plainly here because "any GitHub account can
                  // write" is a demo decision, not an accident.
                  claims.push(new Claim('roles', 'write:pets', GITHUB_ISSUER))

                  return claims
                }),
            { includeEmail: true },
          )
          // GitHub is the default, so no controller in this application has to name a scheme. Anonymous
          // requests to a guarded route are redirected into the OAuth flow rather than answered 401 — this is
          // a browser-first demo, and the documentation (Basic) is the one place that differs.
          .default('GitHub'),
      )
      // JSX server-side rendering. Registering it is optional — `HTML(...)` renders without it — and what it
      // configures is whether the markup is prefixed with a doctype.
      .with(() => html())
      .with(staticFiles(s => s.serve(publicRoot, { prefix: '/static' })))
      // The document is generated from the routes themselves — @Schema, @Status, @Authorize, the $p pickers and
      // the routers' own `.schema()` are the source, and @APIGroup/@Operation (with their `apiGroup()` and
      // `operation()` twins) add only what those cannot say. 3.2.0 because QUERY /pets needs it: a 3.1 path item
      // has no field for a method outside the fixed set.
      .with(
        openapi(o =>
          o
            .version('3.2.0')
            .info({
              title: 'Modern Petstore',
              version: '1.0.0',
              description: 'A pet adoption API, modelled on the OpenAPI 3.2 Modern Petstore specification.',
            })
            // Relative on purpose. A consumer resolves it against wherever it fetched the document, so it is right
            // at any host or port — an absolute URL here was stale the moment the port changed. It also keeps the
            // documentation UI's "Try it" on this origin, which is what lets the browser attach the GitHub session
            // cookie: a cross-origin request would send none.
            .server('/', 'This server')
            // The one place in this application that names an authentication scheme. Everything else runs on the
            // default (GitHub), so only the documentation asks for something different — and because a route's
            // named schemes are the only ones it accepts, a live GitHub session does not open the docs.
            //
            // The reverse also holds, and the UI cannot paper over it: GitHub sign-in is a browser round trip that
            // ends in a cookie, so it happens at /login/github, not in the documentation's authentication panel.
            .secure(s => s.schemes('Basic'))
            // The fallback error handler answers 422 for a body that fails validation, not Fastify's default 400.
            .errors({ validation: 422 })
            .errorSchema(APIErrorSchema),
        ),
      )
      .with(() => multipartPlugin())
      // Kubernetes probes: /livez, /readyz, /startupz.
      .with(health())
      // The two features written as routers rather than controllers. Mounting is what carries their route types
      // onto the application, which is what a typed client reads back.
      .mount(ordersRouter, inventoriesRouter)
  )
}

/** The application's type, routes included — what `brewer` and `testClient` are parameterized by. */
export type PetstoreApp = ReturnType<typeof buildApp>
