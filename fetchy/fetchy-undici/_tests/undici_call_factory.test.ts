import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PoolOptionsBuilder } from '../pool_options_builder.js'
import { UndiciCallFactory } from '../undici_call_factory.js'
import { startTestServer, type TestServer } from './test_server.js'

describe('UndiciCallFactory', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
  })

  afterEach(() => server.stop())

  it('provide() returns a working Call against a real server', async () => {
    const factory = new UndiciCallFactory()
    const call = factory.provide(server.baseURL)

    const response = await call.execute(new Request(`${server.baseURL}/ping?x=1`))
    const body = (await response.json()) as { method: string; url: string }

    expect(response.status).toBe(200)
    expect(body.method).toBe('GET')
    expect(body.url).toBe('/ping?x=1')
  })

  it('forwards a request body to the server', async () => {
    const factory = new UndiciCallFactory()
    const call = factory.provide(server.baseURL)

    const response = await call.execute(
      new Request(`${server.baseURL}/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      }),
    )
    const body = (await response.json()) as { method: string; body: string }

    expect(body.method).toBe('POST')
    expect(body.body).toBe(JSON.stringify({ name: 'Ada' }))
    await factory.pool()?.close()
  })

  it('exposes the underlying Pool via pool(), which can be closed', async () => {
    const factory = new UndiciCallFactory()
    expect(factory.pool()).toBeUndefined()

    factory.provide(server.baseURL)
    const pool = factory.pool()

    expect(pool).toBeDefined()
    expect(pool?.closed).toBe(false)

    await pool?.close()

    expect(pool?.closed).toBe(true)
  })

  it('honors PoolOptionsBuilder-built options', async () => {
    const options = PoolOptionsBuilder.newBuilder().connections(1).pipelining(1).build()
    const factory = new UndiciCallFactory(options)
    const call = factory.provide(server.baseURL)

    const response = await call.execute(new Request(`${server.baseURL}/ping`))

    expect(response.status).toBe(200)
    await factory.pool()?.close()
  })
})
