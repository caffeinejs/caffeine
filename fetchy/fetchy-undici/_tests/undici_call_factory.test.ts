import { type Call, FetchyHeaders, FetchyRequest, newClient } from '@caffeinejs/fetchy'
import { errors, Pool } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PoolOptionsBuilder } from '../pool_options_builder.js'
import { UndiciCall } from '../undici_call.js'
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

    const response = await call.execute(new FetchyRequest('GET', server.baseURL, '/ping?x=1'))
    const body = (await response.json()) as { method: string; url: string }

    expect(response.status).toBe(200)
    expect(body.method).toBe('GET')
    expect(body.url).toBe('/ping?x=1')
    await call.close?.()
  })

  it('forwards a request body to the server', async () => {
    const factory = new UndiciCallFactory()
    const call = factory.provide(server.baseURL)

    const response = await call.execute(
      new FetchyRequest(
        'POST',
        server.baseURL,
        '/users',
        new FetchyHeaders({ 'content-type': 'application/json' }),
        JSON.stringify({ name: 'Ada' }),
      ),
    )
    const body = (await response.json()) as { method: string; body: string }

    expect(body.method).toBe('POST')
    expect(body.body).toBe(JSON.stringify({ name: 'Ada' }))
    await call.close?.()
  })

  // The pool is the call's own: nothing else can reach it to close it, so the call has to.
  it('closes the pool it created when the call is closed', async () => {
    const call = new UndiciCallFactory().provide(server.baseURL)
    await (await call.execute(new FetchyRequest('GET', server.baseURL, '/ping'))).text()

    await call.close?.()

    await expect(call.execute(new FetchyRequest('GET', server.baseURL, '/ping'))).rejects.toBeInstanceOf(
      errors.UndiciError,
    )
  })

  // A factory used to keep only the last pool it made, so sharing it between two clients leaked the first one.
  it('gives each provide() its own pool, so closing one client leaves another working', async () => {
    const factory = new UndiciCallFactory()
    const first = factory.provide(server.baseURL)
    const second = factory.provide(server.baseURL)

    await first.close?.()
    const response = await second.execute(new FetchyRequest('GET', server.baseURL, '/ping'))

    expect(response.status).toBe(200)
    await response.text()
    await second.close?.()
  })

  // Whoever created a dispatcher closes it. One a caller hands to `UndiciCall` may be shared with other code.
  it("leaves a caller's own dispatcher open when the client closes", async () => {
    const pool = new Pool(server.baseURL)
    const client = newClient()
      .baseURL(server.baseURL)
      .callFactory({ provide: () => new UndiciCall(pool) })
      .build()

    await client.close()

    expect(pool.closed).toBe(false)
    await pool.close()
  })

  it('closes its pool when the client built with it closes', async () => {
    const factory = new UndiciCallFactory()
    let provided: Call | undefined
    const client = newClient()
      .baseURL(server.baseURL)
      .callFactory({ provide: baseURL => (provided = factory.provide(baseURL)) })
      .build()

    await (await provided!.execute(new FetchyRequest('GET', server.baseURL, '/ping'))).text()
    await client.close()

    await expect(provided!.execute(new FetchyRequest('GET', server.baseURL, '/ping'))).rejects.toBeInstanceOf(
      errors.UndiciError,
    )
  })

  it('honors PoolOptionsBuilder-built options', async () => {
    const options = PoolOptionsBuilder.newBuilder().connections(1).pipelining(1).build()
    const factory = new UndiciCallFactory(options)
    const call = factory.provide(server.baseURL)

    const response = await call.execute(new FetchyRequest('GET', server.baseURL, '/ping'))

    expect(response.status).toBe(200)
    await response.text()
    await call.close?.()
  })
})
