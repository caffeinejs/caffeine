import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { ENCODE } from './compress.testkit.js'
import { decompression } from './decompression.js'

const CODINGS = ['zstd', 'br', 'gzip', 'deflate'] as const

const app = createWebApplication()
  .with(decompression())
  .mount(
    // Wrapped: a body of `""` or `null` returned bare is an empty text answer, not JSON.
    new Router('/echo').post('/').handler(ctx => ({ value: ctx.req.body() })),
  )

beforeAll(() => app.bootstrap())
afterAll(() => app.close())

describe('decompression() (property)', () => {
  // Decoding is invisible to the route: whatever the parser makes of a body, a 400 for one it refuses included, it
  // makes of the same body coded.
  it.prop([fc.jsonValue({ maxDepth: 3 }), fc.constantFrom(...CODINGS)], { numRuns: 100 })(
    'answers any JSON body sent in any coding it decodes as it answers the same body uncoded',
    async (value, coding) => {
      const json = Buffer.from(JSON.stringify(value))
      const send = (body: Uint8Array, headers: Record<string, string>) =>
        app.request('/echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        })

      const plain = await send(json, {})
      const coded = await send(ENCODE[coding](json), { 'content-encoding': coding })
      const strip = (text: string) => text.replace(/"(?:correlation_id|timestamp)":"[^"]*"/g, '')

      expect(coded.status).toBe(plain.status)
      expect(strip(await coded.text())).toBe(strip(await plain.text()))
    },
  )
})
