import type { WebApplication } from '@caffeinejs/http'

import { createContainer } from '../../app.container.js'
import { buildApp } from '../../app.js'
import { rootModule } from '../../root.gen.mod.js'

// The header sets a browser sends. They mirror `static/_tests/scenarios/_headers.ts` and the e2e browser
// simulator, because what counts as a navigation is the one thing the authentication scheme and
// `isDocumentRequest` must agree on — a suite that invented its own vectors would not be testing that. Each
// carries `Sec-Fetch-Site` as well, which is what `csrf()` reads: a browser sends it with every request to a
// site it can trust, and `localhost` is one.

/** The address bar, a link, a form: what gets a document, and what gets redirected to sign in. */
export const NAVIGATION: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

/** `fetch()` from the page: never a document, never a redirect. */
export const XHR: Record<string, string> = {
  accept: 'application/json',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
}

/** A form on another site, posting here: the request CSRF protection exists for. */
export const CROSS_SITE: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

/** A `<script src>` or `<link>` the shell references. */
export const SCRIPT: Record<string, string> = {
  accept: '*/*',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-dest': 'script',
}

/** curl's defaults, which are also what most HTTP client libraries send. */
export const CURL: Record<string, string> = { accept: '*/*', 'user-agent': 'curl/8.7.1' }

/** kube-probe: no Fetch Metadata, a bare wildcard `Accept`. */
export const PROBE: Record<string, string> = { accept: '*/*', 'user-agent': 'kube-probe/1.30' }

/** The application, silent, on a container built from the generated module graph. */
export function newApp(): WebApplication {
  return buildApp(createContainer(rootModule), { logger: false }) as WebApplication
}

/** A signed-in browser: the cookies to send back. */
export interface Session {
  cookie: string
}

function cookiesFrom(res: Response, into: Map<string, string>): Map<string, string> {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0]!
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)

    if (value === '') {
      into.delete(name)
    } else {
      into.set(name, value)
    }
  }

  return into
}

function header(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Signs in and returns what a later request needs: the session cookie, which authenticates. The sign-in itself
 * passes `csrf()` because `XHR` says what a browser says of a same-origin `fetch`.
 */
export async function signIn(app: WebApplication, username: string, password: string): Promise<Session> {
  const cookies = new Map<string, string>()

  const res = await app.fetch('/auth/login', {
    method: 'POST',
    headers: { ...XHR, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (res.status !== 200) {
    throw new Error(`Cannot sign in as "${username}": ${res.status} ${await res.text()}`)
  }

  cookiesFrom(res, cookies)

  return { cookie: header(cookies) }
}

/** Asserts the JSON envelope the error pipeline renders for a 404, which is what "not the page" means here. */
export async function expectNotFoundJSON(res: Response): Promise<void> {
  if (res.status !== 404) {
    throw new Error(`expected 404, got ${res.status}: ${await res.text()}`)
  }

  const type = res.headers.get('content-type') ?? ''
  if (!type.startsWith('application/json')) {
    throw new Error(`expected a JSON 404, got content-type "${type}"`)
  }

  const body = (await res.json()) as { statusCode?: number; code?: string }
  if (body.statusCode !== 404 || body.code !== 'ERR_HTTP_NOT_FOUND') {
    throw new Error(`expected the ERR_HTTP_NOT_FOUND envelope, got ${JSON.stringify(body)}`)
  }
}
