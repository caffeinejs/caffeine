import type { Browser, Page } from '../browser/index.js'

/**
 * Helpers to drive the Spring Authorization Server (test/services/oauthserver) from the authentication e2e specs.
 * Spring authenticates the user with a form-login page, so a sign-in is a navigation that stops there, a form
 * post, and the redirects that follow it back to the application.
 */

export const OAUTH_SERVER = 'http://localhost:9000'

/** True when the dockerized authorization server is reachable; specs skip when it is not. */
export async function oauthServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OAUTH_SERVER}/actuator/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Signs in on Spring's login page and follows the saved authorization request back to the application.
 *
 * @param page - Where a navigation to a protected URL stopped. It has to be Spring's login form.
 * @throws Error when `page` is not the login form, which means the challenge never reached the provider.
 */
export async function springLogin(browser: Browser, page: Page, username: string, password: string): Promise<Page> {
  if (page.status !== 200 || !page.url.startsWith(`${OAUTH_SERVER}/login`)) {
    throw new Error(
      `Expected Spring's login page, got ${page.status} at ${page.url} (hops: ${page.hops.map(hop => `${hop.status} ${hop.url}`).join(' -> ')})`,
    )
  }

  const csrf = /name="_csrf"[^>]*value="([^"]+)"/.exec(page.text())?.[1]
  if (csrf === undefined) {
    throw new Error('CSRF token not found on the Spring login page')
  }

  return browser.submit(page.url, { username, password, _csrf: csrf })
}

/** An access token from the `client_credentials` grant, the way a service calling a resource server gets one. */
export async function clientCredentialsToken(clientID: string, clientSecret: string, scope: string): Promise<string> {
  const response = await fetch(`${OAUTH_SERVER}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientID}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
    signal: AbortSignal.timeout(5000),
  })

  const body = (await response.json()) as { access_token?: string; error?: string }
  if (!response.ok || body.access_token === undefined) {
    throw new Error(`Cannot get a client_credentials token for "${clientID}": ${response.status} ${body.error ?? ''}`)
  }

  return body.access_token
}
