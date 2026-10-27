import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { describe, it, expect } from 'vitest'

import { formData, multipart } from './index.js'

const BOUNDARY = '----TestBoundary123'

const schema = $t.Object({ uploads: $t.Object({ limits: $t.Object({ fileSize: $t.Bytes() }) }) })

function upload(content: string) {
  return {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body:
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="report.txt"\r\n` +
      `Content-Type: text/plain\r\n` +
      `\r\n` +
      `${content}\r\n` +
      `--${BOUNDARY}--\r\n`,
  }
}

describe('multipart()', () => {
  // What the callback buys: the limits come from the setup context, so a deployment tightens them in its
  // configuration rather than in code.
  it('registers @fastify/multipart with the options the callback reads from the configuration', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ uploads: { limits: { fileSize: '8b' } } }))
      .build().config
    const router = new Router('/uploads')
    router.post('/').handler(async ctx => {
      await formData(ctx).files()
      return {}
    })
    const app = createWebApplication({ config: conf })
      .with(multipart(({ config }) => config.uploads))
      .mount(router)

    await app.bootstrap()

    expect((await app.request('/uploads', upload('12345678'))).status).toBe(200)
    expect((await app.request('/uploads', upload('123456789'))).status).toBe(413)

    await app.close()
  })
})
