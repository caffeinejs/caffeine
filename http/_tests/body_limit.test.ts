import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { KiB } from '@caffeinejs/std/bytes'
import { describe, it, expect } from 'vitest'

import { Controller, Post, BodyLimit, bodyAsBuffer, bodyAsStream, Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

// Fastify's refusal, for a route whose limit is not a whole number of bytes above zero.
const NOT_A_LIMIT = "'bodyLimit' option must be an integer > 0"

describe('BodyLimit', () => {
  it('class-level @BodyLimit rejects bodies exceeding the limit with 413', async () => {
    @BodyLimit(10)
    @Controller('/limited')
    class LimitedController {
      @Post('/data')
      post() {
        return { ok: true }
      }
    }

    void [LimitedController]

    const app = createWebApplication()
    await app.bootstrap()

    const over = await app.fetch('/limited/data', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(20),
    })

    expect(over.status).toBe(413)
  })

  it('method-level @BodyLimit overrides class-level', async () => {
    @BodyLimit(100)
    @Controller('/mixed-limit')
    class MixedLimitController {
      @Post('/class-limit')
      classLimit() {
        return { ok: true }
      }

      @BodyLimit(10)
      @Post('/route-limit')
      routeLimit() {
        return { ok: true }
      }
    }

    void [MixedLimitController]

    const app = createWebApplication()
    await app.bootstrap()

    const body = 'x'.repeat(50)
    const headers = { 'content-type': 'text/plain' }

    const classRes = await app.fetch('/mixed-limit/class-limit', { method: 'POST', headers, body: body })

    const routeRes = await app.fetch('/mixed-limit/route-limit', { method: 'POST', headers, body: body })

    expect(classRes.status).toBe(200)
    expect(routeRes.status).toBe(413)
  })

  it('holds a body to exactly the limit written with the constants', async () => {
    @BodyLimit(1 * KiB)
    @Controller('/kib-limit')
    class KiBLimitController {
      @Post('/data')
      post() {
        return { ok: true }
      }
    }

    void [KiBLimitController]

    const app = createWebApplication()
    await app.bootstrap()

    const headers = { 'content-type': 'text/plain' }
    const atLimit = await app.fetch('/kib-limit/data', { method: 'POST', headers, body: 'x'.repeat(1024) })
    const over = await app.fetch('/kib-limit/data', { method: 'POST', headers, body: 'x'.repeat(1025) })

    expect(atLimit.status).toBe(200)
    expect(over.status).toBe(413)
  })

  // A limit is a count of bytes, checked where the route registers: a bad one fails bootstrap(), not the first
  // request. Each application here has a container of its own, so a bad limit stays out of the other applications
  // this file starts.
  describe('a limit that is not a whole number of bytes above zero', () => {
    const invalid: unknown[] = [1.5, 0, -1, Number.NaN, '1kb']

    it.each(invalid)('fails bootstrap() for %o', async limit => {
      const router = new Router('/bad-limit')
      router
        .post('/data')
        .bodyLimit(limit as number)
        .handler(() => ({ ok: true }))

      const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) }).mount(router)

      await expect(app.bootstrap()).rejects.toThrow(NOT_A_LIMIT)
    })

    // These two register through a parser of their own, nested under the route.
    it.each([
      ['buffer', bodyAsBuffer()],
      ['stream', bodyAsStream()],
    ] as const)('fails bootstrap() on a route reading its body as a %s', async (_, readsBody) => {
      const router = new Router('/bad-raw-limit')
      router
        .post('/data')
        .bodyLimit(1.5)
        .extend(readsBody)
        .handler(() => ({ ok: true }))

      const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) }).mount(router)

      await expect(app.bootstrap()).rejects.toThrow(NOT_A_LIMIT)
    })

    // Text such as '1kb' was a limit before limits were counts of bytes; one left behind fails loudly.
    it('fails bootstrap() for text left on a decorator', async () => {
      @Profile('body-limit-text')
      @BodyLimit('1kb' as never)
      @Controller('/text-limit')
      class TextLimitController {
        @Post('/data')
        post() {
          return { ok: true }
        }
      }

      void [TextLimitController]

      const app = createWebApplication({ container: new CaffeineIoC({ profiles: ['body-limit-text'] }) })

      await expect(app.bootstrap()).rejects.toThrow(NOT_A_LIMIT)
    })
  })
})
