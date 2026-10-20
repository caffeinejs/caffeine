import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'
import { fromAnotherRealm } from './_realm.js'

/**
 * What a call hands the transport beyond its route: the RequestInit fields that steer redirects, aborts and caching,
 * and the failures that happen before any response exists.
 *
 * Redirects and aborts run over a socket: an application's own `fetch` never follows a redirect and does not watch a
 * signal, so only a real transport shows what the client asked of it.
 */

// Holds a request in its handler until the test lets it go, so an abort lands while the server is still working.
let latch: { started: () => void; held: Promise<void> } | undefined

function hold(): { started: Promise<void>; release: () => void } {
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  latch = { started: started.resolve, held: held.promise }

  return { started: started.promise, release: held.resolve }
}

const routes = new Router('/transport')
  .get('/held')
  .handler(async () => {
    latch?.started()
    await latch?.held
    return { done: true }
  })
  .get('/moved')
  .handler(ctx => ctx.redirect('/transport/here'))
  .get('/here')
  .handler(() => ({ here: true }))

// An abort can leave the client a connection it opened and never finished a request on, which the server's graceful
// close would otherwise wait out (caffeinejs/caffeine#131): every connection is closed as the server closes.
const app = createWebApplication()
  .server(() => ({ factory: { forceCloseConnections: true } }))
  .mount(routes)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

describe('brewer over a socket', () => {
  describe('given a route that redirects', () => {
    it('should follow it, as fetch does unless told otherwise', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.transport.moved.get()

      expect(res.redirected).toBe(true)
      expect(await res.json()).toEqual({ here: true })
    })

    it('should hand the redirect back when the client asks for it manually, unless the call follows it', async () => {
      const client = brewer<typeof app>(origin, { redirect: 'manual' })

      const manual = await client.transport.moved.get()
      const followed = await client.transport.moved.get({ redirect: 'follow' })

      expect(manual.status).toBe(302)
      expect(manual.headers.get('location')).toBe('/transport/here')
      expect(await followed.json()).toEqual({ here: true })
    })

    it('should reject when the call treats a redirect as an error', async () => {
      const client = brewer<typeof app>(origin)

      await expect(client.transport.moved.get({ redirect: 'error' })).rejects.toThrow(TypeError)
    })
  })

  describe('given a request aborted while the server is still working on it', () => {
    it('should reject with the abort when the call signals it', async () => {
      const client = brewer<typeof app>(origin)
      const controller = new AbortController()
      const { started, release } = hold()

      try {
        const pending = client.transport.held.get({ signal: controller.signal })
        await started
        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        release()
      }
    })

    // A signal on the client is shared by every call made through it: once it aborts, so does every later call.
    it('should reject with the abort when the client signals it, and refuse every call after', async () => {
      const controller = new AbortController()
      const client = brewer<typeof app>(origin, { signal: controller.signal })
      const { started, release } = hold()

      try {
        const pending = client.transport.held.get()
        await started
        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await expect(client.transport.here.get()).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        release()
      }
    })
  })

  describe('given an origin nothing listens on', () => {
    it('should reject, since no response exists to resolve with', async () => {
      const gone = createWebApplication().mount(routes)
      await gone.run()
      const address = gone.address!.origin
      await gone.close()

      await expect(brewer<typeof app>(address).transport.here.get()).rejects.toThrow(TypeError)
    })
  })
})

describe('brewer handing a call to its transport', () => {
  function spied() {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = brewer(app, {
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      fetch: (input, init = {}) => {
        calls.push({ url: String(input), init })
        return app.fetch(input as string, init)
      },
    })

    return { client, calls }
  }

  it("should pass the client's RequestInit fields on, a call's own winning over them", async () => {
    const { client, calls } = spied()

    await client.transport.here.get({ cache: 'reload' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      cache: 'reload',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    })
    expect(calls[0]!.init).not.toHaveProperty('duplex')
  })

  // A body made in another realm fails `instanceof` against this one's classes, but `fetch` still sends it as what it
  // is. Answered here, since Node's own `fetch` reads a Blob by its prototype too.
  describe('given a body made in another realm', () => {
    const upload = new Router('/upload').post('/').handler(() => ({ received: true }))

    function recorded() {
      const calls: RequestInit[] = []
      const client = brewer<typeof upload>('http://localhost', {
        headers: { 'content-type': 'application/json' },
        fetch: async (_input, init = {}) => {
          calls.push(init)
          return new Response(null, { status: 204 })
        },
      })

      return { client, calls }
    }

    // None goes under the client's JSON type: a Blob under its own, a form under the one the platform writes for it.
    it.each([
      ['a Blob', () => new Blob(['png'], { type: 'image/png' })],
      ['a File', () => new File(['%PDF-1.7'], 'adoption.pdf', { type: 'application/pdf' })],
      ['a FormData', () => new FormData()],
      ['a URLSearchParams', () => new URLSearchParams({ name: 'Rex' })],
    ])('should hand %s over as it is, under its own content type', async (_body, make) => {
      const { client, calls } = recorded()
      const body = fromAnotherRealm(make())

      await client.upload.post({ body })

      expect(calls[0]!.body).toBe(body)
      expect(new Headers(calls[0]!.headers).has('content-type')).toBe(false)
    })

    it('should hand a stream over as it is, to be sent as it is read', async () => {
      const { client, calls } = recorded()
      const body = fromAnotherRealm(new ReadableStream<Uint8Array>())

      await client.upload.post({ body })

      expect(calls[0]!.body).toBe(body)
      expect(calls[0]).toHaveProperty('duplex', 'half')
    })
  })

  describe('given a headers function that fails', () => {
    it.each([
      [
        'throws',
        () => {
          throw new Error('the token could not be refreshed')
        },
      ],
      ['rejects', async () => Promise.reject(new Error('the token could not be refreshed'))],
    ])('should reject the call with its error when it %s, and send nothing', async (_how, headers) => {
      const calls: string[] = []
      const client = brewer(app, {
        headers,
        fetch: (input, init) => {
          calls.push(String(input))
          return app.fetch(input as string, init)
        },
      })

      await expect(client.transport.here.get()).rejects.toThrow('the token could not be refreshed')
      expect(calls).toEqual([])
    })
  })
})
