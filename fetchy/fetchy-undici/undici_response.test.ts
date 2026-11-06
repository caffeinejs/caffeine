import { getEventListeners, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Agent } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UndiciResponse } from './undici_response.js'

/**
 * undici lets go of a call's signal only once the body of its answer closes. A body nobody can read, as on a 204,
 * must close by itself, or a signal the call was given keeps the whole request alive: a signal combined with
 * `AbortSignal.any`, as a time limiter builds for every call, is kept by Node for as long as it has a listener.
 */

let server: Server | undefined
const agent = new Agent()

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise(resolve => server?.close(resolve) ?? resolve(undefined))
  server = undefined
})

async function answering(status: number, body?: string): Promise<string> {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function call(origin: string, signal: AbortSignal): Promise<UndiciResponse> {
  const data = await agent.request({ origin, path: '/', method: 'POST', body: '{}', signal })
  return new UndiciResponse(data)
}

describe('an answer with no body', () => {
  it.each([204, 205, 304])('lets go of the signal of a call answered %i', async status => {
    const origin = await answering(status)
    const signal = AbortSignal.any([new AbortController().signal])

    const res = await call(origin, signal)

    expect(res.status).toBe(status)
    await vi.waitFor(() => expect(getEventListeners(signal, 'abort')).toHaveLength(0))
  })

  it('still reads as no body', async () => {
    const origin = await answering(204)

    const res = await call(origin, new AbortController().signal)

    expect(res.body).toBe(null)
    expect(await res.text()).toBe('')
  })
})

describe('an answer with a body', () => {
  // Releasing only what nobody can read: a body left unread stays the caller's to read or cancel.
  it('holds the signal until its body is cancelled', async () => {
    const origin = await answering(200, '{"a":1}')
    const signal = AbortSignal.any([new AbortController().signal])

    const res = await call(origin, signal)
    expect(getEventListeners(signal, 'abort')).toHaveLength(1)

    await res.body?.cancel()
    await vi.waitFor(() => expect(getEventListeners(signal, 'abort')).toHaveLength(0))
  })
})
