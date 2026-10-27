import { Args, BodyLimit, Controller, Post } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { KiB } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { $multipart, multipartPlugin } from './index.js'

const BOUNDARY = '----TestBoundary123'

/** A form holding one file of `bytes` bytes under `avatar`. */
function upload(bytes: number): Uint8Array {
  return new TextEncoder().encode(
    `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="avatar"; filename="photo.jpg"\r\n' +
      'Content-Type: image/jpeg\r\n' +
      '\r\n' +
      `${'x'.repeat(bytes)}\r\n` +
      `--${BOUNDARY}--\r\n`,
  )
}

describe('$multipart on a decorated route', () => {
  // A route that lowers its limit to refuse large uploads must refuse them, however the route was declared.
  it("refuses an upload over the route's @BodyLimit with 413, as a JSON body over it is refused", async () => {
    @BodyLimit(1 * KiB)
    @Controller('/pl1')
    class LimitedUploadController {
      @Post('/upload')
      @Args([$multipart.file()])
      async upload(f: File | undefined) {
        return { size: f?.size }
      }
    }

    void [LimitedUploadController]

    const app = createWebApplication({}).with(() => multipartPlugin())
    await app.bootstrap()

    const post = (bytes: number) =>
      app.request('/pl1/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: upload(bytes),
      })

    try {
      const over = await post(4096)
      expect(over.status).toBe(413)
      expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

      const within = await post(512)
      expect(within.status).toBe(200)
      expect(await within.json()).toEqual({ size: 512 })
    } finally {
      await app.close()
    }
  })
})
