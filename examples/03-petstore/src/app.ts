import { fileURLToPath } from 'node:url'
import fastify, { type FastifyServerOptions } from 'fastify'
import FastifyMultipart from '@fastify/multipart'
import FastifyCookie from '@fastify/cookie'
import handlebars from 'handlebars'
import type { Container } from '@caffeinejs/di'
import { Claim, WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { viewPlugin } from '@caffeinejs/view'
import { GITHUB_SESSION_COOKIE, JWT_SECRET, githubConfig } from './features/auth/index.js'

const GITHUB_ISSUER = 'https://github.com'
const viewsRoot = fileURLToPath(new URL('./views', import.meta.url))
const publicRoot = fileURLToPath(new URL('./public', import.meta.url))

// Builds the web application from a given container — it never creates one, so tests can pass a
// TestContainer with overridden dependencies. DB-agnostic: no prisma import here.
export function buildApp(container: Container, serverOpts: FastifyServerOptions = {}): WebApplication {
  const server = fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true }, ...serverOpts })
    .addHttpMethod('QUERY', { hasBody: true })
  server.register(FastifyMultipart)
  // Required by the GitHub OAuth flow: the callback handler reads the sealed state/session cookies.
  server.register(FastifyCookie)

  return createWebApplication(fastifyAdapterFactory(server), { container }, viewPlugin())
    .view(v => v.engine({ handlebars }).root(viewsRoot).extension('hbs').layout('layout'))
    .static(s => s.serve(publicRoot, { prefix: '/static' }))
    .authentication(auth => auth
      // JWT bearer for API clients.
      .addJWTBearer(o => o.secret(JWT_SECRET))
      // GitHub OAuth 2.0 browser login. The callback route is auto-registered from callbackURL. Fixed
      // cookie names so the scheme selector below can detect a live GitHub session. includeEmail
      // fetches the verified primary email (adds the user:email scope).
      .addGithub('GitHub', o => o
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
          return claims
        }), { includeEmail: true })
      // The request pipeline authenticates one scheme per request; this Forward picks it. A bearer
      // token → JWT; a GitHub session cookie → GitHub; otherwise JWT, so a credential-less request to
      // a protected API route still challenges as Bearer (401) rather than redirecting to GitHub.
      .forward('scheme', ctx => {
        const authorization = ctx.req.header('authorization')
        if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
          return 'Bearer'
        }
        return ctx.req.cookie(GITHUB_SESSION_COOKIE) ? 'GitHub' : 'Bearer'
      })
      .default('scheme'),
    )
    .build()
}
