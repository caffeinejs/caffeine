import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebApplication } from '@caffeinejs/http'
import { newTestContainer } from '@caffeinejs/testing'
import { createContainer } from '../../app.container.js'
import { buildApp } from '../../app.js'
import { signToken } from './tokens.js'

// GitHub's OAuth endpoints. Hardcoded because GITHUB_ENDPOINTS is not re-exported from the
// package's public surface; these URLs are the ones the OAuth2 handler calls.
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

// Stubs GitHub's token/user/emails endpoints. app.fetch drives the app through light-my-request, so
// only the handler's own outbound fetch is replaced here — the request pipeline is untouched.
function stubGithub(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === GITHUB_TOKEN_URL) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_test', token_type: 'bearer' }) }
    }
    if (url === GITHUB_USER_URL) {
      // A realistic GitHub /user body: ~30 fields, many long *_url strings. The default claim mapper
      // would seal all of these and overflow the browser's 4096-byte cookie limit — the size
      // assertion in the flow test guards against regressing the claimMapper whitelist.
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

// Extracts a Set-Cookie value by name from a Response, without following redirects.
function setCookie(res: Response, name: string): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const all = headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
  const found = all.find(c => c.startsWith(`${name}=`))
  return found ? found.slice(name.length + 1).split(';')[0] : ''
}

// Exercises the two authentication schemes wired in app.ts: the JWT bearer API auth and the GitHub
// OAuth browser login. No network and no database — GitHub is stubbed, and /me only reads the
// principal. GitHub credentials fall back to dev placeholders when the env vars are unset.
describe('authentication wiring', () => {
  let app: WebApplication

  beforeAll(async () => {
    app = buildApp(newTestContainer(createContainer()).build(), { logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves an HTML homepage', async () => {
    const res = await app.fetch('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Sign in with GitHub')
    expect(html).toContain('href="/login/github"')
  })

  it('starts the GitHub OAuth flow: /login/github redirects to GitHub with a state cookie', async () => {
    const res = await app.fetch('/login/github')

    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('https://github.com/login/oauth/authorize')
    expect(location).toContain('client_id=')
    expect(location).toContain('state=')
    expect(setCookie(res, 'petstore_gh_state')).toBeTruthy()
  })

  it('completes the flow: login → callback → session cookie → authenticated /me', async () => {
    stubGithub()

    // 1. Initiate: capture the state parameter and its sealed cookie from the real challenge.
    const login = await app.fetch('/login/github')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    const stateCookie = setCookie(login, 'petstore_gh_state')
    expect(state).toBeTruthy()
    expect(stateCookie).toBeTruthy()

    // 2. Callback: GitHub redirects back with the code + matching state; the handler exchanges the
    // code (stubbed), reads the user, and writes the session cookie.
    const callback = await app.fetch(`/login/github/callback?code=fake-code&state=${state}`, {
      headers: { cookie: `petstore_gh_state=${stateCookie}` },
    })
    expect(callback.status).toBe(302)
    const sessionCookie = setCookie(callback, 'petstore_gh_session')
    expect(sessionCookie).toBeTruthy()
    // The sealed session must fit in a single cookie; a browser silently drops one over ~4096 bytes,
    // which is what caused the post-login redirect loop when every GitHub field was sealed.
    expect(sessionCookie.length).toBeLessThan(4096)

    // 3. The session cookie authenticates /me under the GitHub scheme.
    const me = await app.fetch('/me', { headers: { cookie: `petstore_gh_session=${sessionCookie}` } })
    expect(me.status).toBe(200)
    const body = await me.json() as { authenticated: boolean, sub: unknown, name: unknown }
    expect(body.authenticated).toBe(true)
    expect(body.sub).toBe(4242)
    expect(body.name).toBe('The Octocat')

    // 4. Re-hitting /login/github while signed in must redirect to the dashboard, not re-challenge
    // GitHub — otherwise the post-callback return to this route loops forever.
    const relogin = await app.fetch('/login/github', { headers: { cookie: `petstore_gh_session=${sessionCookie}` } })
    expect(relogin.status).toBe(302)
    expect(relogin.headers.get('location')).toBe('/dashboard')
    expect(relogin.headers.get('location')).not.toContain('github.com')

    // 5. The dashboard renders the signed-in identity as HTML.
    const dash = await app.fetch('/dashboard', { headers: { cookie: `petstore_gh_session=${sessionCookie}` } })
    expect(dash.status).toBe(200)
    expect(dash.headers.get('content-type')).toContain('text/html')
    const dashHtml = await dash.text()
    expect(dashHtml).toContain('The Octocat')
    expect(dashHtml).toContain('/logout')

    // 6. Logout clears the session cookie and returns home.
    const logout = await app.fetch('/logout', { headers: { cookie: `petstore_gh_session=${sessionCookie}` } })
    expect(logout.status).toBe(302)
    expect(logout.headers.get('location')).toBe('/')
    expect(setCookie(logout, 'petstore_gh_session')).toBe('')
  })

  it('redirects an anonymous /dashboard to GitHub (protected)', async () => {
    const res = await app.fetch('/dashboard')

    // No bearer, no session → Forward picks Bearer → 401 challenge (the API default), not a redirect.
    expect(res.status).toBe(401)
  })

  it('authenticates /me with a JWT bearer token', async () => {
    const token = await signToken('tester', ['reader'])

    const res = await app.fetch('/me', { headers: { authorization: `Bearer ${token}` } })

    expect(res.status).toBe(200)
    const body = await res.json() as { authenticated: boolean, sub: unknown, roles: unknown[] }
    expect(body.authenticated).toBe(true)
    expect(body.sub).toBe('tester')
    expect(body.roles).toContain('reader')
  })

  it('challenges /me as Bearer (401) when no credentials are present', async () => {
    const res = await app.fetch('/me')

    expect(res.status).toBe(401)
  })
})
