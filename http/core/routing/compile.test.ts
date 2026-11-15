import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import {
  AuthenticateResult,
  Authentication,
  Authorization,
  BaseAuthenticationHandler,
  ErrAuthenticationGateRequired,
  Guards,
  Router,
  type Guard,
} from '../../index.js'
import { ACCESS_CONTROL_EXEMPT, kAccessControlExempt } from '../security/exempt.js'

class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

class DenyAll implements Guard {
  guard(): boolean {
    return false
  }
}

const marked = () =>
  new Router('/marked')
    .config(kAccessControlExempt, ACCESS_CONTROL_EXEMPT)
    .get('/')
    .handler(() => 'ok')
const forged = () =>
  new Router('/forged')
    .config(kAccessControlExempt, true)
    .get('/')
    .handler(() => 'ok')
const plain = () => new Router('/plain').get('/').handler(() => 'ok')

/**
 * A route the framework serves on the application's behalf, a health probe, carries the access-control mark: the
 * application's global guards and its authorization leave it alone.
 */
describe('the access-control mark', () => {
  const opened: Array<{ close(): Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(app => app.close().catch(() => undefined)))
  })

  it('leaves the global guards off a marked route, and on one an application marked itself', async () => {
    const app = createWebApplication()
      .install(Guards(g => g.global(DenyAll)))
      .mount(marked(), forged(), plain())
    app.container.bind(DenyAll, t => t.toSelf())
    opened.push(app)
    await app.bootstrap()

    expect((await app.request('/marked')).status).toBe(200)
    expect((await app.request('/forged')).status).toBe(403)
    expect((await app.request('/plain')).status).toBe(403)
  })

  it('compiles no authorization for a marked route, so no fallback policy reaches it', async () => {
    const app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .mount(marked())
    opened.push(app)
    await app.bootstrap()

    expect((await app.request('/marked')).status).toBe(200)
  })

  it('leaves an unmarked route under the fallback policy, which the fetch application refuses without a gate', async () => {
    const app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .mount(plain())
    opened.push(app)

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthenticationGateRequired)
  })
})
