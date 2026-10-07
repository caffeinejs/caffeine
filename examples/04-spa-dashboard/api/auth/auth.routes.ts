import {
  AuthenticationService,
  AuthenticationTicket,
  CredentialsService,
  ErrHTTPBadRequest,
  newRouter,
  type Principal,
} from '@caffeinejs/http'

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
 * Sign-in, sign-out, and the one thing the client needs for its own state: the current principal.
 *
 * Only `/auth/me` is gated. The other two are `allowAnonymous` because they both have to work before there is a
 * session — including sign-out, so that signing out twice is not a 401. Neither takes a CSRF token: the
 * framework's `csrf()` judges every unsafe request by its Fetch Metadata, which a same-origin `fetch` sends by
 * itself, so a login form posted from another site is refused before it reaches here.
 */
export const authRouter = newRouter('/auth')
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
    return { ok: true, user: describe(principal) }
  })

  .post('/logout')
  .authorize({ allowAnonymous: true })
  .inject({ auth: AuthenticationService })
  .handler(async (ctx, { auth }) => {
    if (ctx.user.authenticated) {
      await auth.revoke(ctx, SCHEME)
    }

    return { ok: true }
  })

  // No `authorize` at all, so the application's `requireAuthenticatedByDefault()` covers it: anonymous callers
  // are challenged, and the client reads that as "not signed in".
  .get('/me', ctx => describe(ctx.user))
