import { Router, bodyAsBuffer, bodyAsStream } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { multipart, multipartPlugin } from '@caffeinejs/multipart'
import { $t } from '@caffeinejs/std/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * What a call sends, by content type, as the server reads it back.
 *
 * Every route answers with what reached it, so each test asserts on the request the server saw rather than on what
 * the client meant to send.
 */

type Part = { field: string; value: string } | { field: string; name: string; type: string; bytes: number[] }

// Resolved by the streaming route as the first chunk of a body reaches it.
let firstChunk: (() => void) | undefined

// What a multipart request carried, part by part, in order.
async function partsOf(form: FormData): Promise<Part[]> {
  const parts: Part[] = []

  for (const [field, value] of form) {
    if (typeof value === 'string') {
      parts.push({ field, value })
    } else {
      parts.push({ field, name: value.name, type: value.type, bytes: Array.from(await value.bytes()) })
    }
  }

  return parts
}

const echo = new Router('/echo')
  .post('/raw')
  .extend(bodyAsBuffer())
  .handler(ctx => ({
    type: ctx.req.header('content-type') ?? null,
    bytes: Array.from(ctx.req.body() as Uint8Array),
  }))
  .post('/parsed')
  .handler(ctx => ({ type: ctx.req.header('content-type') ?? null, body: ctx.req.body() }))
  .post('/stream')
  .extend(bodyAsStream())
  .handler(async ctx => {
    let size = 0
    for await (const chunk of ctx.req.body() as ReadableStream<Uint8Array>) {
      size += chunk.byteLength
      firstChunk?.()
    }

    return { size }
  })

const uploads = new Router('/uploads')
  .post('/form')
  .handler(async ctx => ({
    type: ctx.req.header('content-type') ?? null,
    parts: await partsOf(await multipart(ctx).formData()),
  }))
  .post('/profile')
  .schema({ body: $t.Object({ caption: $t.String(), avatar: $t.File(), photos: $t.Optional($t.Files()) }) })
  .handler(async ctx => ({ parts: await partsOf(await multipart(ctx).formData()) }))

const adoptions = new Router('/adoptions')
  .post('/')
  .schema({
    body: $t.Object({ name: $t.String(), age: $t.Integer(), tags: $t.Array($t.String()), vaccinated: $t.Boolean() }),
  })
  .handler(ctx => ({ type: ctx.req.header('content-type') ?? null, body: ctx.req.body() }))

const app = createWebApplication()
  .with(() => multipartPlugin())
  .mount(echo, uploads, adoptions)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

describe('brewer sending a body', () => {
  // The boundary is written by the platform as it encodes the form, so a content type set by hand can only lose it.
  describe('given a FormData and a content type set by hand', () => {
    const form = () => {
      const data = new FormData()
      data.set('caption', 'Rex at the beach')
      data.set('avatar', new File(['jpeg-bytes'], 'rex.jpg', { type: 'image/jpeg' }))
      return data
    }
    const expected = [
      { field: 'caption', value: 'Rex at the beach' },
      {
        field: 'avatar',
        name: 'rex.jpg',
        type: 'image/jpeg',
        bytes: Array.from(new TextEncoder().encode('jpeg-bytes')),
      },
    ]

    it('should keep the boundary when the client sets a content type for every request', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/json' } })

      const res = await client.uploads.form.post({ body: form() })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        type: expect.stringMatching(/^multipart\/form-data; boundary=/),
        parts: expected,
      })
    })

    it('should keep the boundary when the call names multipart/form-data itself', async () => {
      const client = brewer(app)

      const res = await client.uploads.form.post({ body: form(), headers: { 'content-type': 'multipart/form-data' } })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        type: expect.stringMatching(/^multipart\/form-data; boundary=/),
        parts: expected,
      })
    })
  })

  describe('given a URLSearchParams under a JSON content type set for every request', () => {
    it('should still send a form', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/json' } })

      const res = await client.echo.parsed.post({ body: new URLSearchParams({ name: 'Rex' }) })

      expect(await res.json()).toEqual({
        type: 'application/x-www-form-urlencoded;charset=UTF-8',
        body: { name: 'Rex' },
      })
    })
  })

  describe('given a ReadableStream', () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([250, 251, 252, 253])]

    it('should send every chunk, in order', async () => {
      const client = brewer(app)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          chunks.forEach(chunk => controller.enqueue(chunk))
          controller.close()
        },
      })

      const res = await client.echo.raw.post({ body, headers: { 'content-type': 'application/octet-stream' } })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: [1, 2, 3, 250, 251, 252, 253] })
    })

    // The second chunk is only produced once the server has read the first: a client that read the whole stream
    // before sending would wait on it forever.
    it('should send it as it is read, so the server reads the start before the end exists', async () => {
      const client = brewer<typeof app>(origin)
      const seen = Promise.withResolvers<void>()
      firstChunk = seen.resolve
      let pulls = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          pulls++
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(1024).fill(1))
          } else if (pulls === 2) {
            await seen.promise
            controller.enqueue(new Uint8Array(1024).fill(2))
          } else {
            controller.close()
          }
        },
      })

      try {
        const res = await client.echo.stream.post({ body })

        expect(await res.json()).toEqual({ size: 2048 })
      } finally {
        firstChunk = undefined
      }
    })
  })

  describe.each([
    ['in process', () => brewer(app)],
    ['over a socket', () => brewer<typeof app>(origin)],
  ] as const)('given a route that declares its upload, %s', (_transport, connect) => {
    it('should deliver the caption and every file, each with its name, type and bytes', async () => {
      const client = connect()
      const form = new FormData()
      form.set('caption', 'Rex at the beach')
      form.set('avatar', new File(['avatar'], 'rex.jpg', { type: 'image/jpeg' }))
      form.append('photos', new File(['one'], 'one.png', { type: 'image/png' }))
      form.append('photos', new File(['two'], 'two.png', { type: 'image/png' }))
      const bytes = (text: string) => Array.from(new TextEncoder().encode(text))

      const res = await client.uploads.profile.post({ body: form })

      expect(await res.json()).toEqual({
        parts: [
          { field: 'caption', value: 'Rex at the beach' },
          { field: 'avatar', name: 'rex.jpg', type: 'image/jpeg', bytes: bytes('avatar') },
          { field: 'photos', name: 'one.png', type: 'image/png', bytes: bytes('one') },
          { field: 'photos', name: 'two.png', type: 'image/png', bytes: bytes('two') },
        ],
      })
    })
  })

  // Every server parses a classic form, and validates it against the same schema as JSON, coercing as it goes.
  describe('given a URLSearchParams for a route that declares an object', () => {
    it('should send a form the server reads as the declared types', async () => {
      const client = brewer(app)
      const form = new URLSearchParams([
        ['name', 'Rex'],
        ['age', '3'],
        ['tags', 'calm'],
        ['tags', 'small'],
        ['vaccinated', 'true'],
      ])

      const res = await client.adoptions.post({ body: form })

      expect(await res.json()).toEqual({
        type: 'application/x-www-form-urlencoded;charset=UTF-8',
        body: { name: 'Rex', age: 3, tags: ['calm', 'small'], vaccinated: true },
      })
    })

    it('should read a lone value as a list where the schema declares one', async () => {
      const client = brewer(app)

      const res = await client.adoptions.post({
        body: new URLSearchParams({ name: 'Rex', age: '3', tags: 'calm', vaccinated: 'false' }),
      })

      expect(await res.json()).toMatchObject({ body: { tags: ['calm'], vaccinated: false } })
    })
  })
})
