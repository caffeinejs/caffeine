/**
 * Helpers to drive the Spring Authorization Server (test/services/oauthserver) over real HTTP from the
 * OIDC/OAuth2 e2e specs. Spring authenticates the user with a form-login page, so the
 * authorization-code flow is scripted here: GET the authorize URL, follow to /login, scrape the
 * CSRF token, POST credentials, then follow the saved-request redirects until the client callback
 * (…/callback?code=…&state=…) is reached.
 */

const OAUTH_SERVER = 'http://localhost:9000'

/** True when the dockerized authorization server is reachable; specs skip when it is not. */
export async function oauthServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OAUTH_SERVER}/actuator/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

class CookieJar {
  readonly #jar = new Map<string, string>()

  absorb(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      const eq = pair.indexOf('=')
      if (eq > 0) {
        this.#jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
      }
    }
  }

  header(): string {
    return [...this.#jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/**
 * Performs Spring's form login for an authorization request and returns the final redirect to the
 * client callback. `callbackOrigin` is the caffeine callback base (e.g. http://localhost:9999) —
 * the loop stops once a redirect points there.
 */
export async function springLogin(
  authorizeUrl: string,
  username: string,
  password: string,
  callbackOrigin: string,
): Promise<string> {
  const jar = new CookieJar()

  // Authorize while unauthenticated → 302 to the login page.
  let res = await fetch(authorizeUrl, { headers: { accept: 'text/html', cookie: jar.header() }, redirect: 'manual' })
  jar.absorb(res)
  let location = res.headers.get('location')
  if (!location) {
    throw new Error(`Expected a redirect to the login page, got status ${res.status}`)
  }

  // Fetch the login page for its CSRF token.
  const loginUrl = new URL(location, OAUTH_SERVER).toString()
  res = await fetch(loginUrl, { headers: { cookie: jar.header() } })
  jar.absorb(res)
  const csrf = /name="_csrf"[^>]*value="([^"]+)"/.exec(await res.text())?.[1]
  if (!csrf) {
    throw new Error('CSRF token not found on the Spring login page')
  }

  // Post credentials.
  res = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username, password, _csrf: csrf }).toString(),
    redirect: 'manual',
  })
  jar.absorb(res)
  location = res.headers.get('location')
  if (!location) {
    throw new Error(`Login POST did not redirect (status ${res.status}) — bad credentials?`)
  }

  // Follow the saved authorization request through to the client callback.
  for (let hop = 0; hop < 6; hop++) {
    const next = new URL(location, OAUTH_SERVER).toString()
    if (next.startsWith(callbackOrigin)) {
      return next
    }
    res = await fetch(next, { headers: { accept: 'text/html', cookie: jar.header() }, redirect: 'manual' })
    jar.absorb(res)
    const loc = res.headers.get('location')
    if (!loc) {
      throw new Error(`Authorization flow stalled at ${next} (status ${res.status})`)
    }
    location = loc
  }
  throw new Error('Authorization flow did not reach the client callback')
}

/** Returns the first `name=value` Set-Cookie whose name contains `nameIncludes` and has a value. */
export function pickCookie(res: Response, nameIncludes: string): string {
  for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0]
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      continue
    }
    if (pair.slice(0, eq).includes(nameIncludes) && pair.slice(eq + 1).length > 0) {
      return pair
    }
  }
  throw new Error(`No Set-Cookie matching "${nameIncludes}" in the response`)
}
