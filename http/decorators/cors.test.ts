import { CaffeineIoC } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { corsPolicy } from '../core/cors/cors.js'
import { Controller } from './controller.js'
import { CORS } from './cors.js'
import { Get } from './verbs.js'

const A = 'https://app.example'
const PARTNER = 'https://partner.example'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

// Each controller has a path of its own: `@Controller` registers into a registry every later container snapshots.
describe('@CORS', () => {
  it("sets a controller's origins over the policy's", async () => {
    @CORS({ origins: [PARTNER] })
    @Controller('/dc')
    class Partnered {
      @Get('/')
      get(): string {
        return 'dc'
      }
    }
    void Partnered

    const built = createWebApplication({ container: new CaffeineIoC() }).with(corsPolicy(c => c.origins(A)))
    app = built
    await built.bootstrap()

    expect(
      (await built.request('/dc', { headers: { origin: PARTNER } })).headers.get('access-control-allow-origin'),
    ).toBe(PARTNER)
    expect((await built.request('/dc', { headers: { origin: A } })).headers.get('access-control-allow-origin')).toBe(
      null,
    )
  })

  it('turns CORS off for one method', async () => {
    @Controller('/dm')
    class Mixed {
      @Get('/on')
      on(): string {
        return 'on'
      }

      @CORS(false)
      @Get('/off')
      off(): string {
        return 'off'
      }
    }
    void Mixed

    const built = createWebApplication({ container: new CaffeineIoC() }).with(corsPolicy(c => c.origins(A)))
    app = built
    await built.bootstrap()

    expect((await built.request('/dm/on', { headers: { origin: A } })).headers.get('access-control-allow-origin')).toBe(
      A,
    )
    expect(
      (await built.request('/dm/off', { headers: { origin: A } })).headers.get('access-control-allow-origin'),
    ).toBe(null)
  })
})
