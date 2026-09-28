import { once } from 'node:events'
import { get } from 'node:https'
import { createServer } from 'node:net'

import { createWebApplication, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { testTLS, testTLSCertificate } from './index.js'

function getHTTPS(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    get(url, { ca: testTLSCertificate() }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }))
      response.on('error', reject)
    }).on('error', reject)
  })
}

async function unusedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Cannot get a TCP port for the TLS test')
  }

  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return address.port
}

describe('testTLS', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('publishes the same TLS identity through the package subpath', async () => {
    const published = await import('@caffeinejs/testing/tls')

    expect(published.testTLS()).toEqual(testTLS())
    expect(published.testTLSCertificate()).toBe(testTLSCertificate())
  })

  it('serves HTTPS on a loopback port with the exported certificate trusted by the client', async () => {
    app = createWebApplication().server(() => testTLS())
    app.mount(newRouter().get('/ping', () => ({ ok: true })))

    await app.run()

    expect(app.address?.host).toBe('127.0.0.1')
    expect(app.address?.port).toBeGreaterThan(0)
    expect(app.address?.origin).toBe(`https://127.0.0.1:${app.address?.port}`)
    expect(await getHTTPS(`${app.address!.origin}/ping`)).toEqual({ status: 200, body: { ok: true } })
  })

  it('composes with other server factory options', async () => {
    app = createWebApplication()
      .server(() => ({ factory: { bodyLimit: 2048 } }))
      .server(() => testTLS())

    await app.bootstrap()

    expect(app.instance.initialConfig.bodyLimit).toBe(2048)
    expect(app.instance.initialConfig.https).toBe(true)
  })

  it('allows the listener port to be overridden in the returned settings', async () => {
    const port = await unusedPort()
    const tls = testTLS()
    app = createWebApplication().server(() => ({ ...tls, listener: { ...tls.listener, port } }))
    app.mount(newRouter().get('/ping', () => ({ ok: true })))

    await app.run()

    expect(app.address?.port).toBe(port)
    expect(await getHTTPS(`${app.address!.origin}/ping`)).toEqual({ status: 200, body: { ok: true } })
  })
})
