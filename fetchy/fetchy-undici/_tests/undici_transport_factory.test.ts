import { FetchyHeaders, FetchyRequest, newClient, type Transport } from '@caffeinejs/fetchy'
import { errors, Pool } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PoolOptionsBuilder } from '../pool_options_builder.js'
import { UndiciTransport } from '../undici_transport.js'
import { UndiciTransportFactory } from '../undici_transport_factory.js'
import { startTestServer, type TestServer } from './test_server.js'

describe('UndiciTransportFactory', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
  })

  afterEach(() => server.stop())

  it('provide() returns a working Transport against a real server', async () => {
    const factory = new UndiciTransportFactory()
    const transport = factory.provide(server.baseURL)

    const response = await transport.send(new FetchyRequest('GET', server.baseURL, '/ping?x=1'))
    const body = (await response.json()) as { method: string; url: string }

    expect(response.status).toBe(200)
    expect(body.method).toBe('GET')
    expect(body.url).toBe('/ping?x=1')
    await transport.close?.()
  })

  it('forwards a request body to the server', async () => {
    const factory = new UndiciTransportFactory()
    const transport = factory.provide(server.baseURL)

    const response = await transport.send(
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
    await transport.close?.()
  })

  // The pool is the transport's own: nothing else can reach it to close it, so the transport has to.
  it('closes the pool it created when the transport is closed', async () => {
    const transport = new UndiciTransportFactory().provide(server.baseURL)
    await (await transport.send(new FetchyRequest('GET', server.baseURL, '/ping'))).text()

    await transport.close?.()

    await expect(transport.send(new FetchyRequest('GET', server.baseURL, '/ping'))).rejects.toBeInstanceOf(
      errors.UndiciError,
    )
  })

  // A factory used to keep only the last pool it made, so sharing it between two clients leaked the first one.
  it('gives each provide() its own pool, so closing one client leaves another working', async () => {
    const factory = new UndiciTransportFactory()
    const first = factory.provide(server.baseURL)
    const second = factory.provide(server.baseURL)

    await first.close?.()
    const response = await second.send(new FetchyRequest('GET', server.baseURL, '/ping'))

    expect(response.status).toBe(200)
    await response.text()
    await second.close?.()
  })

  // Whoever created a dispatcher closes it. One a caller hands to `UndiciTransport` may be shared with other code.
  it("leaves a caller's own dispatcher open when the client closes", async () => {
    const pool = new Pool(server.baseURL)
    const client = newClient()
      .baseURL(server.baseURL)
      .transportFactory({ provide: () => new UndiciTransport(pool) })
      .build()

    await client.close()

    expect(pool.closed).toBe(false)
    await pool.close()
  })

  it('closes its pool when the client built with it closes', async () => {
    const factory = new UndiciTransportFactory()
    let provided: Transport | undefined
    const client = newClient()
      .baseURL(server.baseURL)
      .transportFactory({ provide: baseURL => (provided = factory.provide(baseURL)) })
      .build()

    await (await provided!.send(new FetchyRequest('GET', server.baseURL, '/ping'))).text()
    await client.close()

    await expect(provided!.send(new FetchyRequest('GET', server.baseURL, '/ping'))).rejects.toBeInstanceOf(
      errors.UndiciError,
    )
  })

  it('honors PoolOptionsBuilder-built options', async () => {
    const options = PoolOptionsBuilder.newBuilder().connections(1).pipelining(1).build()
    const factory = new UndiciTransportFactory(options)
    const transport = factory.provide(server.baseURL)

    const response = await transport.send(new FetchyRequest('GET', server.baseURL, '/ping'))

    expect(response.status).toBe(200)
    await response.text()
    await transport.close?.()
  })
})
