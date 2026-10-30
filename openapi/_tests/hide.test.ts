import { $t } from '@caffeinejs/application/schema'
import { $p, Args, Controller, Post, Schema, WebApplication } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { OpenAPI } from '../feature.js'
import { openapi } from '../openapi.js'
import type { OpenAPIDocument } from '../spec/spec.js'

const Note = $t.Object({ text: $t.String() })

@Controller('/notes')
class NotesController {
  @Post('/')
  @Schema({ hide: true, body: Note })
  @Args([$p.body()])
  create(body: object) {
    return body
  }
}
void [NotesController]

function drafts() {
  const router = newRouter('/drafts').name('Drafts')
  router
    .post('/')
    .schema({ hide: true, body: Note })
    .handler(ctx => ctx.body(ctx.req.body))
  router.get('/').handler(() => [])
  return router
}

// `hide` is the convention `@fastify/swagger` reads off a Fastify schema; Caffeine honours it the same way.
describe('a route schema with hide: true', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function boot(): Promise<WebApplication> {
    app = createWebApplication({})
      .install(OpenAPI())
      .with(openapi(o => o.docs(false)))
      .with(openapi('internal', o => o.docs(false)))
      .mount(drafts()) as WebApplication
    await app.bootstrap()
    return app
  }

  it('is left out of every document, from a controller and from a router alike', async () => {
    const served = await boot()

    for (const path of ['/openapi.json', '/openapi/internal.json']) {
      const document = (await (await served.request(path)).json()) as OpenAPIDocument

      expect(Object.keys(document.paths ?? {})).toEqual(['/drafts'])
      expect(Object.keys(document.paths?.['/drafts'] ?? {})).toEqual(['get'])
    }
  })

  // Hiding is documentation only: the route keeps answering, and keeps rejecting what its schema rejects.
  it('is still served and validated', async () => {
    const served = await boot()
    const post = (path: string, body: unknown) =>
      served.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect((await post('/notes', { text: 'hello' })).status).toBe(200)
    expect((await post('/notes', {})).status).toBe(400)
    expect((await post('/drafts', { text: 'hello' })).status).toBe(200)
    expect((await post('/drafts', {})).status).toBe(400)
  })
})
