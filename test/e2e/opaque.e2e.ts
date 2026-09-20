import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { newRouter } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'
import { reachable } from './internal/redis/index.js'
import { REDIS_URL, RedisOpaqueTokenStore, connectRedis, type RedisClient } from './internal/redis/stores.js'
import { required } from './internal/strict.js'

/**
 * Opaque bearer tokens looked up in Redis: nothing in the token to verify, so the store is the whole of the
 * decision, and revoking one is deleting a key.
 */

const up = required('redis', await reachable(REDIS_URL))

describe.skipIf(!up)('opaque bearer tokens held in Redis', () => {
  let redis: RedisClient
  let store: RedisOpaqueTokenStore
  let bearer: RunningApp
  let custom: RunningApp

  const get = (app: RunningApp, path: string, authorization?: string): Promise<BrowserResponse> =>
    new Browser().xhr(`${app.origin}${path}`, authorization === undefined ? {} : { headers: { authorization } })

  function routes() {
    return newRouter().mount(
      newRouter('/whoami')
        .authorize({})
        .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value })),
      newRouter('/admin')
        .authorize({ roles: ['admin'] })
        .get('/', () => ({ ok: true })),
    )
  }

  beforeAll(async () => {
    redis = await connectRedis()
    store = new RedisOpaqueTokenStore(redis, `caffeine:auth:e2e:${randomUUID()}`)

    bearer = await startApp(app =>
      app.authentication(auth => auth.addOpaqueToken(o => o.store(store).realm('api'))).mount(routes()),
    )
    custom = await startApp(app =>
      app.authentication(auth => auth.addOpaqueToken(o => o.store(store).scheme('Token'))).mount(routes()),
    )
  })

  afterAll(async () => {
    await bearer.close()
    await custom.close()
    await redis.close()
  })

  it('accepts a token the store knows, with the roles it was issued with', async () => {
    const token = await store.issue('alice', ['admin'], 60)

    const response = await get(bearer, '/whoami', `Bearer ${token}`)
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ sub: 'alice' })

    expect((await get(bearer, '/admin', `Bearer ${token}`)).status).toBe(200)
    expect((await get(bearer, '/admin', `Bearer ${await store.issue('bob', ['user'], 60)}`)).status).toBe(403)
  })

  // RFC 6750 §3: a bare challenge for a caller that sent nothing, `invalid_token` for one whose token was refused,
  // so a client can tell "sign in" from "this token is no good any more".
  it('challenges when no token is sent, and says the token is invalid when it sent one the store never issued', async () => {
    const none = await get(bearer, '/whoami')
    expect(none.status).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer realm="api"')

    const unknown = await get(bearer, '/whoami', 'Bearer never-issued')
    expect(unknown.status).toBe(401)
    expect(unknown.headers['www-authenticate']).toBe('Bearer realm="api", error="invalid_token"')
  })

  it('says the token is not enough when it is good and the route asks for more', async () => {
    const response = await get(bearer, '/admin', `Bearer ${await store.issue('bob', ['user'], 60)}`)

    expect(response.status).toBe(403)
    expect(response.headers['www-authenticate']).toBe('Bearer realm="api", error="insufficient_scope"')
  })

  it('stops accepting a token the moment it is revoked', async () => {
    const token = await store.issue('alice', ['admin'], 60)
    expect((await get(bearer, '/whoami', `Bearer ${token}`)).status).toBe(200)

    await store.revoke(token)

    expect((await get(bearer, '/whoami', `Bearer ${token}`)).status).toBe(401)
  })

  it('stops accepting a token when it expires', async () => {
    const token = await store.issue('alice', ['admin'], 1)
    expect((await get(bearer, '/whoami', `Bearer ${token}`)).status).toBe(200)

    await sleep(1500)

    expect((await get(bearer, '/whoami', `Bearer ${token}`)).status).toBe(401)
  })

  it('never stores the token itself', async () => {
    const token = await store.issue('alice', ['admin'], 60)

    const keys: string[] = []
    for await (const batch of redis.scanIterator({ MATCH: 'caffeine:auth:e2e:*' })) {
      keys.push(...(Array.isArray(batch) ? batch : [batch]))
    }

    expect(keys.length).toBeGreaterThan(0)
    expect(keys.some(key => key.includes(token))).toBe(false)
  })

  it('reads the scheme keyword the application configured, and only that one', async () => {
    const token = await store.issue('alice', ['admin'], 60)

    expect((await get(custom, '/whoami', `Token ${token}`)).status).toBe(200)

    // No realm was configured, so none is advertised — not an empty one.
    const wrongScheme = await get(custom, '/whoami', `Bearer ${token}`)
    expect(wrongScheme.status).toBe(401)
    expect(wrongScheme.headers['www-authenticate']).toBe('Token')
  })
})
