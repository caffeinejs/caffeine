import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import {
  AuthenticateResult,
  Authentication,
  Authorization,
  BaseAuthenticationHandler,
  ErrAuthenticationGateRequired,
  ErrConfiguration,
  Guards,
  HTTPPlugin,
  Router,
  type Guard,
  type HTTPSetupContext,
} from '../../index.js'
import { accessControlExempt } from '../security/exempt.js'

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
    .routeOptions(accessControlExempt())
    .get('/')
    .handler(() => 'ok')
const forged = () =>
  new Router('/forged')
    .routeOptions({ accessControlExempt: true as never })
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

  // The mark leaves authorization off, so a route that asks for it as well would be served without it, and silently.
  it('refuses an exempt route that declares authorization itself', async () => {
    const app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .mount(
        new Router('/open')
          .name('open')
          .routeOptions(accessControlExempt())
          .get('/')
          .name('index')
          .authorize({ roles: ['admin'] })
          .handler(() => 'ok'),
      )
    opened.push(app)

    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message.split('\n')[0]).toBe(
      'Cannot serve "open.index": it is outside access control and declares authorization',
    )
  })

  // A probe under an authorized router is the framework's route, not the router's: the mark wins over what it inherits.
  it('lets an exempt route under an authorized group through', async () => {
    const seen: unknown[] = []
    const app = createWebApplication()
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ app }: HTTPSetupContext): void {
              app.hook('onRoute', route => {
                seen.push(route.route.authorization)
              })
            }
          })(),
      )
      .mount(
        new Router('/outer').authorize({ roles: ['admin'] }).mount(
          new Router('/inner')
            .routeOptions(accessControlExempt())
            .get('/')
            .handler(() => 'ok'),
        ),
      )
    opened.push(app)
    await app.bootstrap()

    expect(seen).toEqual([expect.objectContaining({ hasProtection: false, authorizer: undefined })])
    expect((await app.request('/outer/inner')).status).toBe(200)
  })
})
