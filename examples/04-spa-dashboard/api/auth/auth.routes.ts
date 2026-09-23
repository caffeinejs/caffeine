import {
  AuthenticationService,
  AuthenticationTicket,
  CredentialsService,
  ErrHTTPBadRequest,
  newRouter,
  type Context,
  type Principal,
} from '@caffeinejs/http'

import { CSRF_COOKIE } from '../app.config.js'

/** The scheme's registered name. `addCookie(...)` with no name uses this one. */
const SCHEME = 'Cookie'

interface LoginBody {
  username?: unknown
  password?: unknown
}

/** The principal as the client needs it: who, and what they may do. */
function describe(principal: Principal): unknown {
  return {
    sub: principal.findFirst('sub')?.value ?? null,
    name: principal.findFirst('name')?.value ?? null,
    roles: principal.findAll('roles').flatMap(claim => (Array.isArray(claim.value) ? claim.value : [claim.value])),
  }
}

/**
 * Issues a CSRF token, rotating the secret it is bound to.
 *
 * `reply.generateCsrf()` mints a new secret **only when the request carried no `_csrf` cookie**; otherwise it
 * reuses the one it was given. So rotating at the session boundary — which is the point of doing it at all —
 * means clearing the request's own copy first, because that is what the plugin reads. Clearing only the reply
 * cookie would issue a token bound to a secret the browser is about to be told to forget, and every unsafe
 * request afterwards would fail with `FST_CSRF_MISSING_SECRET`.
 *
 * The plugin exposes no rotate of its own; this is the whole of it.
 */
function rotateCsrf(ctx: Context): string {
  delete ctx.platform.request.cookies[CSRF_COOKIE]

  return ctx.platform.reply.generateCsrf()
}

/**
 * Sign-in, sign-out, and the two things the client needs to do either: a CSRF token and the current principal.
 *
 * Only `/auth/me` is gated. The other three are `allowAnonymous` because they all have to work before there is
 * a session — including sign-out, so that signing out twice is not a 401.
 */
export const authRouter = newRouter('/auth')
  // A token to put in `x-csrf-token`. The `_csrf` cookie holding the secret is HttpOnly, so the token cannot
  // be read from `document.cookie`; it has to come back in the body. Anonymous, because the login form itself
  // needs one — login CSRF is a real attack, not a technicality.
  .get('/csrf')
  .authorize({ allowAnonymous: true })
  .handler(ctx => ({ token: ctx.platform.reply.generateCsrf() }))

  .post('/login')
  .authorize({ allowAnonymous: true })
  .inject({ auth: AuthenticationService, credentials: CredentialsService })
  .handler(async (ctx, { auth, credentials }) => {
    const body = (ctx.req.body() ?? {}) as LoginBody
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw new ErrHTTPBadRequest('Cannot sign in: "username" and "password" are required')
    }

    const principal = await credentials.attempt(body.username, body.password)
    if (principal === null) {
      // Deliberately not saying which half was wrong.
      ctx.status(401)
      return { ok: false }
    }

    await auth.persist(ctx, SCHEME, new AuthenticationTicket(principal, SCHEME))

    // The principal is described from what was just verified, not from `ctx.user`: `persist` writes the
    // session cookie for the *next* request and does not re-authenticate this one, so `ctx.user` is still
    // anonymous here.
    //
    // The fresh token rides back in the body so the client needs no second round trip.
    return { ok: true, user: describe(principal), csrfToken: rotateCsrf(ctx) }
  })

  .post('/logout')
  .authorize({ allowAnonymous: true })
  .inject({ auth: AuthenticationService })
  .handler(async (ctx, { auth }) => {
    if (ctx.user.authenticated) {
      await auth.revoke(ctx, SCHEME)
    }

    // `revoke` clears the session cookie and knows nothing about any other plugin's, so without this the CSRF
    // secret would outlive the session and be inherited by whoever signs in next in this browser.
    return { ok: true, csrfToken: rotateCsrf(ctx) }
  })

  // No `authorize` at all, so the application's `requireAuthenticatedByDefault()` covers it: anonymous callers
  // are challenged, and the client reads that as "not signed in".
  .get('/me', ctx => describe(ctx.user))
