import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebApplication } from '@caffeinejs/http'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { YAMLConfigSource } from '@caffeinejs/std/config/yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDevToolsUI } from '../index.js'
import { page, startTarget, upstream, type Upstream } from './fixtures.js'

describe("the UI's configuration", () => {
  const opened: WebApplication[] = []
  const upstreams: Upstream[] = []
  let dir: string | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all([
      ...opened.splice(0).map(app => app.close()),
      ...upstreams.splice(0).map(server => server.close()),
    ])

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  function ui(applications: unknown): WebApplication {
    const app = createDevToolsUI({ sources: [new InlineConfigSource({ applications })], logger: false })
    opened.push(app)
    return app
  }

  // What the `caffeine-devtools` command reads: a YAML file, whose secrets come from the environment.
  it('reads applications from a YAML file, interpolating the environment', async () => {
    const target = await startTarget()
    opened.push(target.app)
    vi.stubEnv('ORDERS_DEVTOOLS_URL', target.url)

    dir = mkdtempSync(join(tmpdir(), 'devtools-ui-'))
    const file = join(dir, 'devtools.yaml')
    writeFileSync(file, ['applications:', '  orders:', '    url: "${env:ORDERS_DEVTOOLS_URL}"', ''].join('\n'))

    const view = createDevToolsUI({ sources: [new YAMLConfigSource(file, { optional: false })], logger: false })
    opened.push(view)
    await view.bootstrap()

    const home = await page(view, '/')

    expect(home.text).toContain('href="/orders"')
    expect(home.text.match(/>up</g)).toHaveLength(1)
  })

  it('refuses to start without its YAML file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'devtools-ui-'))

    const view = createDevToolsUI({
      sources: [new YAMLConfigSource(join(dir, 'missing.yaml'), { optional: false })],
      logger: false,
    })
    opened.push(view)

    await expect(view.bootstrap()).rejects.toMatchObject({ code: 'ERR_CONFIG_SOURCE' })
  })

  it('refuses to start with no application to read', async () => {
    await expect(ui({}).bootstrap()).rejects.toMatchObject({ code: 'ERR_CONFIG_VALIDATION' })
  })

  // A URL may carry what must not reach a log, so a refusal names the key, never the value.
  it.each<[string, unknown, RegExp]>([
    [
      'a name that is not a path segment',
      { 'two words': { url: 'http://127.0.0.1:9100/devtools' } },
      /the name is not/,
    ],
    [
      'a URL that is not absolute',
      { orders: { url: '/devtools' } },
      /"applications\.orders\.url" is not an absolute URL/,
    ],
    ['a URL that is not http', { orders: { url: 'ftp://127.0.0.1/devtools' } }, /is not an http or https URL/],
    [
      'a URL with credentials',
      { orders: { url: 'http://ops:s3cr3t@127.0.0.1:9100/devtools' } },
      /"applications\.orders\.url" carries credentials/,
    ],
    [
      'a URL with a query',
      { orders: { url: 'http://127.0.0.1:9100/devtools?token=s3cr3t' } },
      /has a query or a fragment/,
    ],
    [
      'Basic and Bearer credentials together',
      {
        orders: {
          url: 'http://127.0.0.1:9100/devtools',
          auth: { basic: { username: 'a', password: 'b' }, bearer: 't' },
        },
      },
      /both "applications\.orders\.auth\.basic" and "applications\.orders\.auth\.bearer" are set/,
    ],
    [
      'credentials alongside an authorization header',
      { orders: { url: 'http://127.0.0.1:9100/devtools', auth: { bearer: 't' }, headers: { Authorization: 'x' } } },
      /"applications\.orders\.auth" and an "authorization" header are both set/,
    ],
  ])('refuses %s at start-up, without repeating the URL', async (_, applications, message) => {
    const failure = await ui(applications)
      .bootstrap()
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'ERR_DEVTOOLS_UI_CONFIGURATION', message: expect.stringMatching(message) })
    expect(String((failure as Error).message)).not.toContain('s3cr3t')
  })

  it('sends each application its own credentials and headers', async () => {
    const server = await upstream('{"slices":[]}')
    upstreams.push(server)

    const view = ui({
      basic: {
        url: server.url,
        auth: { basic: { username: 'ops', password: 'pässword' } },
        headers: { 'x-tenant': 'acme' },
      },
      bearer: { url: server.url, auth: { bearer: 'opaque-token' } },
    })
    await view.bootstrap()
    await page(view, '/basic')
    await page(view, '/bearer')

    const [basic, bearer] = server.requests

    expect(basic?.headers.authorization).toBe(`Basic ${Buffer.from('ops:pässword', 'utf8').toString('base64')}`)
    expect(basic?.headers['x-tenant']).toBe('acme')
    expect(bearer?.headers.authorization).toBe('Bearer opaque-token')
    expect(bearer?.headers['x-tenant']).toBeUndefined()
  })
})
