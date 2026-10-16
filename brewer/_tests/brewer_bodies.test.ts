import { Router, bodyAsBuffer } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { multipart, multipartPlugin } from '@caffeinejs/multipart'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * What a call sends, by content type, as the server reads it back.
 *
 * Every route answers with what reached it, so each test asserts on the request the server saw rather than on what
 * the client meant to send.
 */

type Part = { field: string; value: string } | { field: string; name: string; type: string; bytes: number[] }

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

const uploads = new Router('/uploads').post('/form').handler(async ctx => ({
  type: ctx.req.header('content-type') ?? null,
  parts: await partsOf(await multipart(ctx).formData()),
}))

const app = createWebApplication()
  .with(() => multipartPlugin())
  .mount(echo, uploads)

beforeAll(async () => {
  await app.bootstrap()
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
})
