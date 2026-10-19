import { runInNewContext } from 'node:vm'

import { $t } from '@caffeinejs/application/schema'
import { Router, bodyAsBuffer, bodyAsStream } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { multipart, multipartPlugin } from '@caffeinejs/multipart'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * What a call sends, by content type, as the server reads it back; and what a call reads back from the server.
 *
 * Every route answers with what reached it, so each test asserts on the request the server saw rather than on what
 * the client meant to send.
 */

type Part = { field: string; value: string } | { field: string; name: string; type: string; bytes: number[] }

/** Every byte value, in order: a body re-encoded as text anywhere along the way would not survive it. */
const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i)

const utf8 = (text: string) => Array.from(new TextEncoder().encode(text))

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
  .post('/limited')
  .extend(bodyAsBuffer())
  .bodyLimit(1024)
  .handler(ctx => ({ size: (ctx.req.body() as Uint8Array).byteLength }))
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

const downloads = new Router('/downloads')
  .get('/report')
  .handler(
    () =>
      new Response(everyByte, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.bin"',
        },
      }),
  )
  .delete('/report')
  .status(204)
  .handler(() => undefined)
  .get('/readme')
  .handler(ctx => {
    ctx.header('content-type', 'text/plain; charset=utf-8')
    return 'Read me first.'
  })

const fileSize = 64 * 1024

const app = createWebApplication()
  .with(() => multipartPlugin({ limits: { fileSize } }))
  .mount(echo, uploads, adoptions, downloads)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

describe('brewer sending a body', () => {
  describe('given an object, sent as JSON', () => {
    it('should send it to a route that declares it, labelled as JSON', async () => {
      const client = brewer(app)
      const body = { name: 'Rex', age: 3, tags: ['calm'], vaccinated: true }

      const res = await client.adoptions.post({ body })

      expect(await res.json()).toEqual({ type: 'application/json', body })
    })

    it('should send a list as a JSON array', async () => {
      const client = brewer(app)

      const res = await client.echo.parsed.post({ body: [1, 'two', { three: 3 }] })

      expect(await res.json()).toEqual({ type: 'application/json', body: [1, 'two', { three: 3 }] })
    })

    it('should keep any text in it intact, a line separator and an emoji included', async () => {
      const client = brewer(app)
      const body = { name: 'Mílou 🐶', note: 'one two' }

      expect(await (await client.echo.parsed.post({ body })).json()).toEqual({ type: 'application/json', body })
    })

    it('should keep the JSON media type a call names, and still encode the object', async () => {
      const client = brewer(app)

      const res = await client.echo.raw.post({
        body: { name: null },
        headers: { 'content-type': 'application/merge-patch+json' },
      })

      expect(await res.json()).toEqual({ type: 'application/merge-patch+json', bytes: utf8('{"name":null}') })
    })

    it('should keep the JSON media type a client names for every request', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/vnd.api+json' } })

      const res = await client.echo.raw.post({ body: { data: { type: 'pets' } } })

      expect(await res.json()).toEqual({
        type: 'application/vnd.api+json',
        bytes: utf8('{"data":{"type":"pets"}}'),
      })
    })
  })

  // Every server parses a classic form, and validates it against the same schema as JSON, coercing as it goes.
  describe('given a URLSearchParams, sent as a form', () => {
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

    it('should send names and values holding reserved characters and unicode as they were given', async () => {
      const client = brewer(app)
      const form = new URLSearchParams([
        ['a&b', 'c=d'],
        ['sp ace', 'x+y z'],
        ['ü', '1'],
        ['ü', '😀'],
      ])

      const res = await client.echo.parsed.post({ body: form })

      expect(await res.json()).toEqual({
        type: 'application/x-www-form-urlencoded;charset=UTF-8',
        body: { 'a&b': 'c=d', 'sp ace': 'x+y z', ü: ['1', '😀'] },
      })
    })

    it('should send a form already encoded as text, under the form type the call names', async () => {
      const client = brewer(app)

      const res = await client.echo.parsed.post({
        body: 'name=Rex&tags=calm&tags=small',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

      expect(await res.json()).toEqual({
        type: 'application/x-www-form-urlencoded',
        body: { name: 'Rex', tags: ['calm', 'small'] },
      })
    })

    it('should still send a form under a JSON content type set for every request', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/json' } })

      const res = await client.echo.parsed.post({ body: new URLSearchParams({ name: 'Rex' }) })

      expect(await res.json()).toEqual({
        type: 'application/x-www-form-urlencoded;charset=UTF-8',
        body: { name: 'Rex' },
      })
    })
  })

  describe('given a FormData, sent as a multipart form', () => {
    const form = () => {
      const data = new FormData()
      data.set('caption', 'Rex at the beach')
      data.set('avatar', new File(['jpeg-bytes'], 'rex.jpg', { type: 'image/jpeg' }))
      return data
    }
    const expected = [
      { field: 'caption', value: 'Rex at the beach' },
      { field: 'avatar', name: 'rex.jpg', type: 'image/jpeg', bytes: utf8('jpeg-bytes') },
    ]

    it('should deliver its fields and files under a boundary the platform wrote', async () => {
      const client = brewer(app)

      const res = await client.uploads.form.post({ body: form() })

      expect(await res.json()).toEqual({
        type: expect.stringMatching(/^multipart\/form-data; boundary=/),
        parts: expected,
      })
    })

    // The boundary is written by the platform as it encodes the form, so a content type set by hand can only lose
    // it.
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

    it('should deliver a binary file byte for byte over a socket', async () => {
      const client = brewer<typeof app>(origin)
      const data = new FormData()
      data.set('report', new File([everyByte], 'report.bin', { type: 'application/octet-stream' }))

      const res = await client.uploads.form.post({ body: data })

      expect(await res.json()).toMatchObject({
        parts: [
          { field: 'report', name: 'report.bin', type: 'application/octet-stream', bytes: Array.from(everyByte) },
        ],
      })
    })

    it('should resolve with 413 for a file over the server limit, rather than throw', async () => {
      const client = brewer(app)
      const data = new FormData()
      data.set('video', new File([new Uint8Array(fileSize + 1)], 'video.mp4', { type: 'video/mp4' }))

      const res = await client.uploads.form.post({ body: data })

      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ code: 'FST_REQ_FILE_TOO_LARGE' })
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

      const res = await client.uploads.profile.post({ body: form })

      expect(await res.json()).toEqual({
        parts: [
          { field: 'caption', value: 'Rex at the beach' },
          { field: 'avatar', name: 'rex.jpg', type: 'image/jpeg', bytes: utf8('avatar') },
          { field: 'photos', name: 'one.png', type: 'image/png', bytes: utf8('one') },
          { field: 'photos', name: 'two.png', type: 'image/png', bytes: utf8('two') },
        ],
      })
    })
  })

  describe('given a string', () => {
    it('should send it as plain text, as it is rather than as a JSON string', async () => {
      const client = brewer(app)

      const res = await client.echo.raw.post({ body: 'Rex says "woof"' })

      expect(await res.json()).toEqual({ type: 'text/plain;charset=UTF-8', bytes: utf8('Rex says "woof"') })
    })

    it.each([
      ['text/csv', 'id,name\n1,Rex\n2,Mílou\n'],
      ['application/xml', '<pet><name>Rex</name></pet>'],
    ])('should send it as %s when the call names that type', async (type, text) => {
      const client = brewer(app)

      const res = await client.echo.raw.post({ body: text, headers: { 'content-type': type } })

      expect(await res.json()).toEqual({ type, bytes: utf8(text) })
    })
  })

  describe('given bytes', () => {
    it('should send a Uint8Array byte for byte', async () => {
      const client = brewer(app)

      const res = await client.echo.raw.post({
        body: everyByte,
        headers: { 'content-type': 'application/octet-stream' },
      })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: Array.from(everyByte) })
    })

    it('should send an ArrayBuffer byte for byte', async () => {
      const client = brewer(app)

      const res = await client.echo.raw.post({
        body: everyByte.slice().buffer,
        headers: { 'content-type': 'application/octet-stream' },
      })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: Array.from(everyByte) })
    })

    // A vm context is a realm of its own, as an iframe is: its ArrayBuffer is not this realm's, and fails `instanceof`.
    it('should send an ArrayBuffer made in another realm byte for byte', async () => {
      const client = brewer(app)
      const bytes = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer

      const res = await client.echo.raw.post({ body: bytes, headers: { 'content-type': 'application/octet-stream' } })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: [1, 2, 3] })
    })

    it('should send only the bytes a view covers, not the whole buffer behind it', async () => {
      const client = brewer(app)
      const view = new Uint8Array(everyByte.slice().buffer, 10, 3)

      const res = await client.echo.raw.post({ body: view, headers: { 'content-type': 'application/octet-stream' } })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: [10, 11, 12] })
    })

    it('should send a Blob under its own type when the call names none', async () => {
      const client = brewer(app)
      const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

      const res = await client.echo.raw.post({ body: png })

      expect(await res.json()).toEqual({ type: 'image/png', bytes: [137, 80, 78, 71] })
    })

    it('should send a File under its own type', async () => {
      const client = brewer(app)
      const pdf = new File(['%PDF-1.7'], 'adoption.pdf', { type: 'application/pdf' })

      const res = await client.echo.raw.post({ body: pdf })

      expect(await res.json()).toEqual({ type: 'application/pdf', bytes: utf8('%PDF-1.7') })
    })

    // A client's content type is a default for a body that has none of its own; a call's is the caller's word.
    it('should keep a Blob under its own type when the client sets another for every request', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/json' } })
      const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

      const res = await client.echo.raw.post({ body: png })

      expect(await res.json()).toEqual({ type: 'image/png', bytes: [137, 80, 78, 71] })
    })

    it('should send a Blob under the type the call names, over its own', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/json' } })
      const csv = new Blob(['id,name\n1,Rex\n'], { type: 'text/plain' })

      const res = await client.echo.raw.post({ body: csv, headers: { 'content-type': 'text/csv' } })

      expect(await res.json()).toEqual({ type: 'text/csv', bytes: utf8('id,name\n1,Rex\n') })
    })

    it('should send a Blob that has no type under the type the client sets', async () => {
      const client = brewer(app, { headers: { 'content-type': 'application/octet-stream' } })

      const res = await client.echo.raw.post({ body: new Blob([new Uint8Array([1, 2, 3])]) })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: [1, 2, 3] })
    })

    it('should send a Blob that has no type with no content type at all', async () => {
      const client = brewer(app)

      const res = await client.echo.raw.post({ body: new Blob([new Uint8Array([1, 2, 3])]) })

      expect(await res.json()).toEqual({ type: null, bytes: [1, 2, 3] })
    })

    it('should resolve with 413 for a body over the route limit, rather than throw', async () => {
      const client = brewer(app)

      const res = await client.echo.limited.post({
        body: new Uint8Array(2048),
        headers: { 'content-type': 'application/octet-stream' },
      })

      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })
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

  describe('given a function that opens a stream', () => {
    // A stream from a file or a socket is opened as the request leaves, and goes under no type the client guessed.
    it.each([
      ['a function', () => new Blob([everyByte]).stream()],
      ['an async function', async () => new Blob([everyByte]).stream()],
    ])('should send every chunk of the stream %s opens', async (_how, open) => {
      const client = brewer(app)

      const res = await client.echo.raw.post({ body: open, headers: { 'content-type': 'application/octet-stream' } })

      expect(await res.json()).toEqual({ type: 'application/octet-stream', bytes: Array.from(everyByte) })
    })

    // Opened lazily is still streamed: the second chunk exists only once the server has read the first.
    it('should send the stream it opens as it is read', async () => {
      const client = brewer<typeof app>(origin)
      const seen = Promise.withResolvers<void>()
      firstChunk = seen.resolve
      let pulls = 0
      const open = () =>
        new ReadableStream<Uint8Array>({
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
        const res = await client.echo.stream.post({ body: open })

        expect(await res.json()).toEqual({ size: 2048 })
      } finally {
        firstChunk = undefined
      }
    })

    // A file that cannot be opened fails the call: it must not go out as an empty upload under its name.
    it('should reject with what the function throws, in process', async () => {
      const client = brewer(app)

      await expect(
        client.echo.raw.post({
          body: () => {
            throw new Error('the file is gone')
          },
        }),
      ).rejects.toThrow('the file is gone')
    })

    it('should reject with what the function throws as its cause, over a socket', async () => {
      const client = brewer<typeof app>(origin)

      await expect(
        client.echo.raw.post({
          body: async () => Promise.reject(new Error('the file is gone')),
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ).rejects.toMatchObject({ name: 'TypeError', cause: { message: 'the file is gone' } })
    })
  })
})

describe('brewer reading a body', () => {
  describe.each([
    ['in process', () => brewer(app)],
    ['over a socket', () => brewer<typeof app>(origin)],
  ] as const)('given a download, %s', (_transport, connect) => {
    it('should hand back every byte, and the headers that name the file', async () => {
      const client = connect()

      const res = await client.downloads.report.get()

      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.bin"')
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(everyByte))
    })
  })

  it('should hand back text as it was sent', async () => {
    const client = brewer(app)

    const res = await client.downloads.readme.get()

    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('Read me first.')
  })

  it('should hand back a 204 with no body to read', async () => {
    const client = brewer<typeof app>(origin)

    const res = await client.downloads.report.delete()

    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    expect(await res.text()).toBe('')
  })
})
