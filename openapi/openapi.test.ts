import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { describe, expect, it } from 'vitest'

import { ErrOpenAPIConfiguration } from './errors.js'
import { OpenAPI } from './feature.js'
import { openapi, type OpenAPIConfigurer } from './openapi.js'

describe('openapi', () => {
  // A plugin covers the scope it registers in: on a router, the document describes that router and is served there.
  it("documents a router's routes alone, and serves the document under the router's path", async () => {
    const app = createWebApplication({ adapter: node() })
      .install(OpenAPI())
      .mount(
        new Router('/r')
          .with(openapi(o => o.public()))
          .get('/pets')
          .handler(() => 'pets'),
        new Router('/other').get('/').handler(() => 'other'),
      )

    try {
      await app.bootstrap()

      const document = (await (await app.request('/r/openapi.json')).json()) as { paths: Record<string, unknown> }
      const page = await (await app.request('/r/docs')).text()

      expect(Object.keys(document.paths)).toEqual(['/r/pets'])
      expect(linksOf(page)[0]).toBe('/r/openapi.json')
    } finally {
      await app.close()
    }
  })

  // One openapi(...) registers once per place its router serves at: a second place names one document twice, and the
  // refusal says so rather than pointing at a second call there is none of.
  it('refuses a router carrying openapi() mounted at two places, naming that cause', async () => {
    const documented = new Router('/r')
      .with(openapi(o => o.public()))
      .get('/pets')
      .handler(() => 'pets')
    const app = createWebApplication({ adapter: node() })
      .install(OpenAPI())
      .mount(new Router('/a').mount(documented), new Router('/b').mount(documented))

    try {
      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrOpenAPIConfiguration)
      expect((err as Error).message.split('\n')[0]).toBe(
        'Cannot register the OpenAPI document "default": the openapi() that registers it serves at more than one place',
      )
    } finally {
      await app.close()
    }
  })

  // A browser follows the page's links from where it opened the page: they resolve on the page's own origin, under the
  // path it was opened at, whatever the request path spelled, and both answer.
  it.each([
    ['a parameter', '/tenants/:id', '/tenants/42/docs', '/tenants/42'],
    ['an encoded "/" in a value', '/tenants/:id', '/tenants/a%2Fb/docs', '/tenants/a%2Fb'],
    ['a value holding a quote and "<"', '/api/v:version', '/api/v1%22%3E%3Cx/docs', '/api/v1%22%3E%3Cx'],
    ['an escaped ":"', '/service::name', '/service:name/docs', '/service:name'],
    ['a parameter named wildcard', '/w/:wildcard', '/w/x/docs', '/w/x'],
    ['a parameter name with "$"', '/teams/:$team', '/teams/red/docs', '/teams/red'],
    // A trailing slash never makes another route, so the page answers there too and its links climb out of it.
    ['a trailing "/" after the page', '/tenants/:id', '/tenants/42/docs/', '/tenants/42'],
    // The query is not part of the path the links are relative to, though it holds a "/".
    ['a query after the page', '/tenants/:id', '/tenants/42/docs?next=/a/', '/tenants/42'],
  ])('links the docs page under %s to where it was opened', async (_, path, url, root) => {
    await expectLinks(path, url, root, o => o.public())
  })

  // A route path is routed with a leading "/" and without a trailing one: the links name it where it is served.
  it.each([
    ['without a leading slash', 'spec.json', 'docs', '/api/docs', ['/api/spec.json', '/api/docs/_scalar.js']],
    ['with a trailing slash', '/openapi.json', '/docs/', '/api/docs/', ['/api/openapi.json', '/api/docs/_scalar.js']],
  ])('links the docs page to endpoints given %s, where they are served', async (_, json, docs, page, served) => {
    const app = createWebApplication({ adapter: node() })
      .install(OpenAPI())
      .mount(
        new Router('/api')
          .with(openapi(o => o.public().json(json).docs(docs)))
          .get('/pets')
          .handler(() => 'pets'),
      )

    try {
      await app.bootstrap()

      const links = linksOf(await (await app.request(page)).text())
      const statuses = await Promise.all(links.map(async link => (await app.request(link)).status))

      expect([links, statuses]).toEqual([served, [200, 200]])
    } finally {
      await app.close()
    }
  })

  // A base written with a trailing slash is routed without it: the links name the endpoints where they are served.
  it('links a docs page under a base with a trailing slash to where it was opened', async () => {
    await expectLinks('/api', '/api/v1/docs', '/api/v1', o => o.public().base('/v1/'))
  })

  // The plugin's own base is a path pattern too: the links keep the values it matched.
  it('links a docs page under a base with a parameter to where it was opened', async () => {
    await expectLinks('/tenants/:tenant', '/tenants/acme/versions/2/docs', '/tenants/acme/versions/2', o =>
      o.public().base('/versions/:version([0-9]+)'),
    )
  })

  // A page served at the scope's own path is opened with the scope's last value as its last segment; a trailing slash
  // never makes another route, so it lies past the page.
  it.each([
    ['/tenants/42', '/tenants/42'],
    ['/tenants/42/', '/tenants/42'],
  ])('links a docs page served at the scope path to the scope, at %s', async (url, root) => {
    await expectLinks('/tenants/:id', url, root, o => o.public().docs('/'), '')
  })

  // A browser reads a link starting with "//" as naming another host: a base spelled that way is read as "/catalog".
  it('never links the docs page to another host', async () => {
    await expectLinks('', '/catalog/docs', '/catalog', o => o.public().base('//catalog'))
  })
})

/** Opens the docs page at `url` and follows its links: both resolve on its origin under `root`, and both answer. */
async function expectLinks(
  path: string,
  url: string,
  root: string,
  configure: OpenAPIConfigurer,
  docs = '/docs',
): Promise<void> {
  const app = createWebApplication({ adapter: node() })
    .install(OpenAPI())
    .mount(
      new Router(path)
        .with(openapi(configure))
        .get('/pets')
        .handler(() => 'pets'),
    )

  try {
    await app.bootstrap()

    const opened = await app.request(url)
    const page = await opened.text()
    // Where a browser that asked for this path is: a path starting with "//" is still a path.
    const at = new URL(`http://localhost${url}`)
    const links = linksOf(page).map(link => new URL(link, at))
    const followed = await Promise.all(
      links.map(async link => {
        const res = await app.request(link.pathname)
        return [res.status, res.headers.get('content-type')?.split(';')[0]]
      }),
    )

    expect([opened.status, page.includes('"><x'), ...links.map(link => link.origin)]).toEqual([
      200,
      false,
      'http://localhost',
      'http://localhost',
    ])
    expect(links.map(link => link.pathname)).toEqual([`${root}/openapi.json`, `${root}${docs}/_scalar.js`])
    expect(followed).toEqual([
      [200, 'application/json'],
      [200, 'text/javascript'],
    ])
  } finally {
    await app.close()
  }
}

/** The document and script URLs the docs page loads, as written in it. */
function linksOf(page: string): string[] {
  return [/data-url="([^"]*)"/.exec(page)![1]!, /<script src="([^"]*)"/.exec(page)![1]!].map(link =>
    link.replaceAll('&amp;', '&'),
  )
}
