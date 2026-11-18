import { KiB } from '@caffeinejs/std/bytes'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { compress, compression } from './compress.js'
import { DECODE, decodeAs } from './compress.testkit.js'
import { selectEncoding } from './negotiate.js'

const CODINGS = ['zstd', 'br', 'gzip', 'deflate'] as const

/** One `Accept-Encoding` entry: a token, as clients spell them, with a qvalue or none. */
const entry = fc
  .record({
    token: fc.constantFrom('zstd', 'br', 'gzip', 'deflate', 'identity', '*', 'x-gzip', 'GZIP', 'compress'),
    q: fc.option(fc.constantFrom('0', '0.1', '0.5', '0.999', '1', '1.000'), { nil: undefined }),
  })
  .map(({ token, q }) => (q === undefined ? token : `${token};q=${q}`))

const acceptEncoding = fc.option(
  fc.array(entry, { maxLength: 6 }).map(entries => entries.join(', ')),
  { nil: undefined },
)

// The bodies a client may hand the route back to it: what the route echoes, the test compares.
let held: { body: Uint8Array; chunks: Uint8Array[] } = { body: new Uint8Array(), chunks: [] }

const app = createWebApplication()
  .with(compression())
  .mount(
    new Router('/bytes')
      .extend(compress({ threshold: 0 }))
      .get('/')
      .handler(ctx => {
        ctx.header('content-type', 'text/plain')
        return held.body
      }),
    new Router('/sized').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return held.body
    }),
    new Router('/stream').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      const chunks = [...held.chunks]
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift()
          if (next === undefined) {
            controller.close()
          } else {
            controller.enqueue(next)
          }
        },
      })
    }),
  )

beforeAll(() => app.bootstrap())
afterAll(() => app.close())

describe('compression() (property)', () => {
  it.prop([fc.uint8Array({ maxLength: 16 * KiB }), acceptEncoding], { numRuns: 200 })(
    'sends any body back intact, in the coding selectEncoding picks or identity',
    async (body, header) => {
      held = { body, chunks: [] }
      const res = await app.request('/bytes', header === undefined ? {} : { headers: { 'accept-encoding': header } })
      const coding = res.headers.get('content-encoding')
      const picked = selectEncoding(header, CODINGS)

      expect(coding).toBe(picked === undefined || picked === 'identity' ? null : picked)
      expect(decodeAs(coding, Buffer.from(await res.arrayBuffer()))).toEqual(Buffer.from(body))
      expect(res.headers.get('vary')).toBe('Accept-Encoding')
    },
  )

  it.prop([fc.uint8Array({ maxLength: 4 * KiB })], { numRuns: 100 })(
    'varies on Accept-Encoding exactly when the body reaches the threshold',
    async body => {
      held = { body, chunks: [] }
      const res = await app.request('/sized', { headers: { 'accept-encoding': 'gzip' } })

      expect(res.headers.get('vary')).toBe(body.byteLength >= 1 * KiB ? 'Accept-Encoding' : null)
      expect(res.headers.get('content-encoding')).toBe(body.byteLength >= 1 * KiB ? 'gzip' : null)
    },
  )

  it.prop(
    [fc.array(fc.uint8Array({ maxLength: 4 * KiB }), { minLength: 1, maxLength: 20 }), fc.constantFrom(...CODINGS)],
    {
      numRuns: 100,
    },
  )('sends any stream back intact, chunk boundaries anywhere', async (chunks, coding) => {
    held = { body: new Uint8Array(), chunks }
    const res = await app.request('/stream', { headers: { 'accept-encoding': coding } })

    expect(res.headers.get('content-encoding')).toBe(coding)
    expect(DECODE[coding](Buffer.from(await res.arrayBuffer()))).toEqual(Buffer.concat(chunks))
  })
})
