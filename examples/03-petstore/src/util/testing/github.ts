import { vi } from 'vitest'
import type { WebApplication } from '@caffeinejs/http'

/**
 * Test helpers for driving the GitHub OAuth flow without a network.
 *
 * Shared because GitHub is now the application's default authentication scheme: any test that needs an
 * authenticated caller — not just the auth tests — has to complete this flow to obtain a session cookie.
 *
 * Lives under `util/` rather than beside the auth feature because `features/pets/` needs it too, and a
 * `_`-prefixed module would be private to its own directory.
 */

// GitHub's OAuth endpoints. Hardcoded because GITHUB_ENDPOINTS is not re-exported from the package's public
// surface; these URLs are the ones the OAuth2 handler calls.
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

export const GITHUB_STATE_COOKIE = 'petstore_gh_state'
export const GITHUB_SESSION_COOKIE_NAME = 'petstore_gh_session'

/**
 * What a browser address-bar request looks like.
 *
 * The GitHub challenge redirects a navigation and answers everything else 401 with the same URL in
 * `location`, because a redirect to github.com is something only a browser can follow. Any test that expects
 * the 302 has to say it is a navigation.
 */
export const NAVIGATION = { 'sec-fetch-mode': 'navigate' }

/**
 * Stubs GitHub's token/user/emails endpoints. `app.fetch` drives the app through light-my-request, so only
 * the handler's own outbound fetch is replaced here — the request pipeline is untouched.
 *
 * The `/user` body is deliberately realistic: GitHub returns ~30 fields, many of them long `*_url` strings.
 * The default claim mapper would seal all of them and overflow the browser's ~4096-byte per-cookie limit, so
 * the size assertion in the flow test is what guards the claimMapper whitelist.
 */
export function stubGithub(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === GITHUB_TOKEN_URL) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_test', token_type: 'bearer' }) }
    }
    if (url === GITHUB_USER_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          login: 'octocat',
          id: 4242,
          node_id: 'MDQ6VXNlcjQyNDI=',
          avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
          gravatar_id: '',
          url: 'https://api.github.com/users/octocat',
          html_url: 'https://github.com/octocat',
          followers_url: 'https://api.github.com/users/octocat/followers',
          following_url: 'https://api.github.com/users/octocat/following{/other_user}',
          gists_url: 'https://api.github.com/users/octocat/gists{/gist_id}',
          starred_url: 'https://api.github.com/users/octocat/starred{/owner}{/repo}',
          subscriptions_url: 'https://api.github.com/users/octocat/subscriptions',
          organizations_url: 'https://api.github.com/users/octocat/orgs',
          repos_url: 'https://api.github.com/users/octocat/repos',
          events_url: 'https://api.github.com/users/octocat/events{/privacy}',
          received_events_url: 'https://api.github.com/users/octocat/received_events',
          type: 'User',
          site_admin: false,
          name: 'The Octocat',
          company: '@github',
          blog: 'https://github.blog',
          location: 'San Francisco',
          email: null,
          hireable: null,
          bio: 'A mysterious cat that lives in the GitHub logo and enjoys long walks on the keyboard.',
          twitter_username: 'octocat',
          public_repos: 8,
          public_gists: 8,
          followers: 9001,
          following: 9,
          created_at: '2011-01-25T18:44:36Z',
          updated_at: '2024-01-25T18:44:36Z',
        }),
      }
    }
    if (url === GITHUB_EMAILS_URL) {
      return { ok: true, status: 200, json: async () => [{ email: 'octocat@github.com', primary: true, verified: true }] }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }))
}

/** Extracts a Set-Cookie value by name from a Response, without following redirects. */
export function setCookie(res: Response, name: string): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const all = headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
  const found = all.find(c => c.startsWith(`${name}=`))
  return found ? found.slice(name.length + 1).split(';')[0] : ''
}

/**
 * Completes the whole OAuth flow against a stubbed GitHub and returns the session cookie value.
 *
 * Call `stubGithub()` first, and remember to `vi.unstubAllGlobals()` afterwards.
 */
export async function signInWithGithub(app: WebApplication): Promise<string> {
  // Sign-in is a browser navigation, and the challenge answers a non-navigation with 401 instead of the
  // 302 this helper follows — so say what this is.
  const login = await app.fetch('/login/github', { headers: NAVIGATION })
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!
  const stateCookie = setCookie(login, GITHUB_STATE_COOKIE)

  const callback = await app.fetch(`/login/github/callback?code=fake-code&state=${state}`, {
    headers: { cookie: `${GITHUB_STATE_COOKIE}=${stateCookie}` },
  })

  return setCookie(callback, GITHUB_SESSION_COOKIE_NAME)
}

/** The `cookie` header carrying a signed-in GitHub session. */
export function sessionHeader(session: string): Record<string, string> {
  return { cookie: `${GITHUB_SESSION_COOKIE_NAME}=${session}` }
}
