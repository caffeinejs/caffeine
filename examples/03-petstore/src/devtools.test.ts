import { afterEach, describe, expect, it } from 'vitest'

import { createContainer } from './app.container.js'
import { type PetstoreApp, buildApp } from './app.js'
import { rootModule } from './root.gen.mod.js'

/**
 * The petstore serves its devtools on a server of their own: the port users reach must not answer them, and the
 * values they show must keep the application's secrets masked.
 */
describe('devtools', () => {
  let app: PetstoreApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('are served on their own server and not on the one users reach', async () => {
    app = buildApp(createContainer(rootModule), { logger: false })
    await app.bootstrap()

    const devtools = app.listeners.get('devtools')!

    expect((await devtools.request('/devtools/routes')).status).toBe(200)
    expect((await app.request('/devtools/routes')).status).toBe(404)
  })

  it('show configuration values with the secrets masked', async () => {
    app = buildApp(createContainer(rootModule), { logger: false })
    await app.bootstrap()

    const res = await app.listeners.get('devtools')!.request('/devtools/config/properties')
    const values = Object.fromEntries(
      ((await res.json()) as Array<{ path: string; value: unknown }>).map(({ path, value }) => [path, value]),
    )

    expect(values['auth.github.clientSecret']).toBe('******')
    expect(values['auth.github.sessionSecret']).toBe('******')
    expect(values['docs.password']).toBe('******')
    // What names no secret is shown as it is.
    expect(typeof values['server.port']).toBe('number')
  })
})
