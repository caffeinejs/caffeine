import { once } from 'node:events'
import { createServer, get, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'

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

describe('testTLS', () => {
  let server: Server | undefined
  let app: WebApplication | undefined

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server!.close(error => (error ? reject(error) : resolve())))
    }
    await app?.close()
    server = undefined
    app = undefined
  })

  it('publishes the same TLS identity through the package subpath', async () => {
    const published = await import('@caffeinejs/testing/tls')

    expect(published.testTLS()).toEqual(testTLS())
    expect(published.testTLSCertificate()).toBe(testTLSCertificate())
  })

  // Only `key` and `cert`, so the result spreads into any TLS options object without dragging settings along.
  it('returns only the key and the certificate', () => {
    const tls = testTLS()

    expect(Object.keys(tls)).toEqual(['key', 'cert'])
    expect(tls.key).toContain('-----BEGIN PRIVATE KEY-----')
    expect(tls.cert).toBe(testTLSCertificate())
  })

  it('serves a bare Node HTTPS server trusted through the exported certificate', async () => {
    server = createServer(testTLS(), (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')

    const { port } = server.address() as AddressInfo

    expect(await getHTTPS(`https://127.0.0.1:${port}/ping`)).toEqual({ status: 200, body: { ok: true } })
  })

  it('serves a Caffeine web application over HTTPS', async () => {
    app = createWebApplication().server(() => ({
      factory: { https: testTLS() },
      listener: { host: '127.0.0.1', port: 0 },
    }))
    app.mount(newRouter().get('/ping', () => ({ ok: true })))

    await app.run()

    expect(app.address?.origin).toBe(`https://127.0.0.1:${app.address?.port}`)
    expect(await getHTTPS(`${app.address!.origin}/ping`)).toEqual({ status: 200, body: { ok: true } })
  })
})
