import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { describe, expect, it } from 'vitest'

import { ErrOpenAPIConfiguration } from './errors.js'
import { OpenAPI } from './feature.js'
import { openapi } from './openapi.js'

describe('openapi', () => {
  // A document describes a server, its base path included, and a router is shared by every server that serves it.
  it('refuses openapi() on a router, which belongs to no server', async () => {
    const app = createWebApplication({ adapter: node() })
      .install(OpenAPI())
      .mount(
        new Router('/r')
          .with(openapi(o => o.docs(false).public()))
          .get('/')
          .handler(() => 'ok'),
      )

    try {
      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrOpenAPIConfiguration)
      expect((err as Error).message.split('\n')[0]).toBe(
        'Cannot install openapi() on a router or a controller: the document "default" describes a server',
      )
    } finally {
      await app.close()
    }
  })
})
