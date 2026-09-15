import { fileURLToPath } from 'node:url'

import type { Container } from '@caffeinejs/di'
import {
  Claim,
  Identity,
  Principal,
  WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
  health,
} from '@caffeinejs/http'
import { multipartPlugin } from '@caffeinejs/multipart'
import { openapi } from '@caffeinejs/openapi'
import { staticFiles } from '@caffeinejs/static'
import { newConfiguration } from '@caffeinejs/std'
import { EnvConfigProvider } from '@caffeinejs/std/config'
import { view } from '@caffeinejs/view'
import FastifyCookie from '@fastify/cookie'
import fastify, { type FastifyServerOptions } from 'fastify'
import handlebars from 'handlebars'

import { appConfigSchema, kAppConfig } from './config.js'
import { GITHUB_SESSION_COOKIE, githubConfig } from './features/auth/index.js'
import { apiErrorSchema } from './util/errors/index.js'

const GITHUB_ISSUER = 'https://github.com'
const viewsRoot = fileURLToPath(new URL('./views', import.meta.url))
const publicRoot = fileURLToPath(new URL('./public', import.meta.url))

// Credentials for the API documentation. Demo defaults so the example runs with no setup; override them
// through the environment for anything that is not a laptop.
const docsUser = process.env.PETSTORE_DOCS_USER ?? 'admin'
const docsPassword = process.env.PETSTORE_DOCS_PASSWORD ?? 'admin123'

// Builds the web application from a given container — it never creates one, so tests can pass a
// TestContainer with overridden dependencies. DB-agnostic: no prisma import here. Health indicators are
// container-managed; `DatabaseHealth` is discovered through the `HealthIndicator` key.
export function buildApp(container: Container, serverOpts: FastifyServerOptions = {}): WebApplication {
  const server = fastify({
    logger: true,
    routerOptions: { ignoreTrailingSlash: true },
    ...serverOpts,
  }).addHttpMethod('QUERY', { hasBody: true, overrideExisting: true })
  // Required by the GitHub OAuth flow: the callback handler reads the sealed state/session cookies.
  server.register(FastifyCookie)

  const conf = newConfiguration(appConfigSchema, kAppConfig)
    .source(new EnvConfigProvider({ prefix: 'PETSTORE_' }))
    .build()

  const builder = createWebApplication(fastifyAdapterFactory(server), {
    container,
    config: conf,
  })
    .with(view(v => v.engine(e => e.engine({ handlebars }).root(viewsRoot).extension('hbs').layout('layout'))))
    .with(staticFiles(s => s.serve(publicRoot, { prefix: '/static' })))
    // The document is generated from the routes themselves — the controllers' @Schema, @Status, @Authorize and
    // $p pickers are the source, and @APIGroup/@Operation add only what those cannot say. 3.2.0 because
    // QUERY /pets needs it: a 3.1 path item has no field for a non-standard method.
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
          .errorSchema(apiErrorSchema),
      ),
    )
    .with(() => multipartPlugin())
    .authentication(auth =>
      auth
        // Basic, for the API documentation only. Demo credentials, overridable from the environment.
        .addBasic('Basic', o =>
          o
            .realm('Petstore docs')
            .validate((_ctx, username, password) =>
              username === docsUser && password === docsPassword
                ? new Principal(true, [new Identity('Basic', true, [new Claim('sub', username, 'petstore')])])
                : null,
            ),
        )
        // GitHub OAuth 2.0 browser login, and the application default: every route that does not name a
        // scheme authenticates with it. The callback route is auto-registered from callbackURL. includeEmail
        // fetches the verified primary email (adds the user:email scope).
        .addGithub(
          'GitHub',
          o =>
            o
              .clientID(githubConfig.clientID)
              .clientSecret(githubConfig.clientSecret)
              .callbackURL(githubConfig.callbackURL)
              .sessionSecret(githubConfig.sessionSecret)
              .sessionCookieName(GITHUB_SESSION_COOKIE)
              .stateCookieName('petstore_gh_state')
              .defaultRedirectPath('/dashboard')
              // Seal only the fields the app uses. GitHub's /user returns ~30 fields (many long *_url
              // strings); the default mapper copies them all, and the sealed session cookie then exceeds
              // the browser's ~4096-byte per-cookie limit, so the browser silently drops it — leaving
              // every post-login request unauthenticated and looping back into the OAuth challenge.
              .claimMapper(u => {
                const claims = [
                  new Claim('sub', u.id, GITHUB_ISSUER), // stable numeric id (subjectClaim stays 'id')
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
    // Server host/port come from PETSTORE_SERVER__HOST / PETSTORE_SERVER__PORT (defaults in the schema).
    .server((s, c) => s.withConfig(c.server))
    // Kubernetes probes: /livez, /readyz, /startupz.
    .with(health())
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

  return builder
}
