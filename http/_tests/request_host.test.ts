import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, newRouter } from '../index.js'

/**
 * `ctx.req.host` and `ctx.req.protocol`: the authority and the scheme the server trusts for a request, which is what
 * a check comparing an `Origin` against the request needs. Behind a proxy they follow the forwarding headers only
 * when the server was told to trust it, so a client cannot name the host it would like to be compared with.
 */
describe('ctx.req.host and ctx.req.protocol', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  const whoami = () => newRouter('/whoami').get('/', ctx => ({ host: ctx.req.host, protocol: ctx.req.protocol }))

  const FORWARDED = { host: 'app.example', 'x-forwarded-host': 'proxied.example', 'x-forwarded-proto': 'https' }

  it('answers the Host header and the socket scheme, ignoring the forwarding headers of a proxy nobody trusts', async () => {
    const app = await ready(createWebApplication().mount(whoami()))

    expect(await (await app.fetch('/whoami', { headers: FORWARDED })).json()).toEqual({
      host: 'app.example',
      protocol: 'http',
    })
  })

  it('follows X-Forwarded-Host and X-Forwarded-Proto under trustProxy', async () => {
    const app = await ready(
      createWebApplication()
        .server(() => ({ factory: { trustProxy: true } }))
        .mount(whoami()),
    )

    expect(await (await app.fetch('/whoami', { headers: FORWARDED })).json()).toEqual({
      host: 'proxied.example',
      protocol: 'https',
    })
  })
})
