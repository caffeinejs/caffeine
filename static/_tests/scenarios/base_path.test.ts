import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { expectNotFoundJSON, fixtures, isolated, NAVIGATION } from './_headers.js'

/**
 * File mounts in an application served under a base path.
 *
 * The server takes the base off a request's URL before routing, so a mount registers its files without the base
 * and every route answers under it and without it.
 */

describe('a file mount under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  function site(): WebApplication {
    return isolated()
      .basePath('/api')
      .with(staticFiles(s => s.serve(fixtures, { prefix: '/static' }))) as WebApplication
  }

  it('serves a file under the base with its bytes, and the same file without the base', async () => {
    app = site()
    await app.bootstrap()

    const expected = readFileSync(join(fixtures, 'hello.txt'), 'utf8')

    for (const url of ['/api/static/hello.txt', '/static/hello.txt']) {
      const res = await app.request(url)

      expect(res.status, url).toBe(200)
      expect(await res.text(), url).toBe(expected)
    }
  })

  it('keeps a miss under the mount a missing file', async () => {
    app = site()
    await app.bootstrap()

    await expectNotFoundJSON(await app.request('/api/static/missing.txt', { headers: NAVIGATION }))
  })

  it('takes nothing off a path that only starts like the base', async () => {
    app = site()
    await app.bootstrap()

    expect((await app.request('/apistatic/hello.txt')).status).toBe(404)
  })
})
