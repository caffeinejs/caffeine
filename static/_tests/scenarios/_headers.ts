import { fileURLToPath } from 'node:url'

import { CaffeineIoC } from '@caffeinejs/di'
import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  createWebApplication,
  Identity,
  Principal,
  type Context,
} from '@caffeinejs/http'

/** The built site every scenario serves: `index.html` with `<div id="root">` and one hashed asset. */
export const dist = fileURLToPath(new URL('../_testdata/spa', import.meta.url))
/** A second built site, for an administration shell: `<div id="admin-root">` and `assets/admin-Zz9.js`. */
export const admin = fileURLToPath(new URL('../_testdata/admin', import.meta.url))
/** Plain files, for a `.serve()` mount next to a shell. */
export const fixtures = fileURLToPath(new URL('../_testdata/fixtures', import.meta.url))
/** A directory holding no `index.html`. */
export const noShell = fileURLToPath(new URL('../_testdata/fixtures2', import.meta.url))

// The header sets a browser sends, mirroring test/e2e/internal/browser/index.ts so the two layers agree on what
// a navigation, a fetch and a script request look like.

/** The address bar, a link, a form: what gets a document. */
export const NAVIGATION: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

/** `fetch()` / `XMLHttpRequest` from a page. */
export const XHR: Record<string, string> = {
  accept: 'application/json',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
}

/** A `<script src>` or `<link>` the shell references. */
export const SCRIPT: Record<string, string> = {
  accept: '*/*',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-dest': 'script',
}

/** A document loaded into an `<iframe>`: a navigation whose destination is not `document`. */
export const IFRAME: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'iframe',
}

/** kube-probe: no Fetch Metadata, a bare wildcard `Accept`. */
export const PROBE: Record<string, string> = {
  accept: '*/*',
  'user-agent': 'kube-probe/1.30',
}

/** curl's defaults, which are also what most HTTP client libraries send. */
export const CURL: Record<string, string> = {
  accept: '*/*',
  'user-agent': 'curl/8.7.1',
}

/**
 * An application that routes only what is mounted on it.
 *
 * Handed a live container the application skips `autoWire()`, so a `@Controller` declared anywhere in the
 * module graph is not routed and each scenario's routers are its whole surface.
 */
export function isolated() {
  return createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
}

/** The `caf.session=...` pair to send back, read off a login response. */
export function sessionCookie(res: Response): string {
  const m = /caf\.session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) {
    throw new Error(`no session cookie in Set-Cookie: ${res.headers.get('set-cookie')}`)
  }

  return `caf.session=${m[1]}`
}

/** A signed-in principal named `subject`, holding `roles`. */
export function principal(subject: string, roles: readonly string[] = [], scheme = 'header'): Principal {
  const claims = [new Claim('sub', subject, ''), ...roles.map(role => new Claim('roles', role, ''))]

  return new Principal(true, [new Identity(scheme, true, claims)])
}

/**
 * A strategy that trusts `x-user` and `x-roles` request headers, for scenarios about authorization rather than
 * about where an identity comes from. No header, no identity.
 */
export class HeaderAuthenticationHandler extends BaseAuthenticationHandler<{}> {
  constructor() {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const user = ctx.req.header('x-user')
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const roles = (ctx.req.header('x-roles') ?? '').split(',').filter(Boolean)

    return AuthenticateResult.success(new AuthenticationTicket(principal(user, roles), 'header'))
  }
}

/** Asserts the JSON envelope the error pipeline renders for a 404, which is what "not HTML" means here. */
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
