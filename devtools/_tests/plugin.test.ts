import { CaffeineIoC } from '@caffeinejs/di'
import { Ops, Router, createWebApplication, type WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools, info, type DevToolsBuilder, type DevToolsIndex } from '../index.js'
import { get, listener, target } from './fixtures.js'

describe('devTools()', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Registering the plugin is the opt-in, so every built-in is served; the index is how a client learns what is.
  it('lists every built-in slice, in order, each where it answers', async () => {
    app = target()
    await app.bootstrap()

    const res = await get(app, '/devtools')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const index = (await res.json()) as DevToolsIndex

    expect(index.slices).toEqual([
      { id: 'bindings', href: '/devtools/bindings' },
      { id: 'graph', href: '/devtools/graph' },
      { id: 'routes', href: '/devtools/routes' },
      { id: 'health', href: '/devtools/health' },
      { id: 'info', href: '/devtools/info' },
      { id: 'configuration', href: '/devtools/configuration' },
    ])

    // What a slice reports is live state: a cached copy would show the application as it was.
    for (const { href } of index.slices) {
      const slice = await get(app, href)

      expect(slice.status, href).toBe(200)
      expect(slice.headers.get('content-type'), href).toMatch(/^application\/json/)
      expect(slice.headers.get('cache-control'), href).toBe('no-store')
    }
  })

  it('serves only the slices it is given', async () => {
    app = target({ devtools: d => d.slices(info()) })
    await app.bootstrap()

    const index = (await (await get(app, '/devtools')).json()) as DevToolsIndex

    expect(index.slices).toEqual([{ id: 'info', href: '/devtools/info' }])
    expect((await get(app, '/devtools/info')).status).toBe(200)
    expect((await get(app, '/devtools/bindings')).status).toBe(404)
  })

  // A fluent method is the last word: what the configuration hands over only fills what code left unset.
  it('serves at the path its setter names over the one the configuration hands it', async () => {
    app = target({ devtools: d => d.config({ path: '/from-tree' }).path('/tools') })
    await app.bootstrap()

    expect((await get(app, '/tools')).status).toBe(200)
    expect((await get(app, '/tools/info')).status).toBe(200)
    expect((await get(app, '/from-tree')).status).toBe(404)
    expect((await get(app, '/devtools')).status).toBe(404)
  })

  it('reads its path from a node of the configuration tree', async () => {
    const conf = newConfiguration($t.Object({ devtools: $t.Object({ path: $t.Optional($t.String()) }) }))
      .source(new InlineConfigSource({ devtools: { path: '/ops-tools' } }))
      .build().config

    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })
      .install(
        Ops('devtools', o =>
          o.server(() => ({ listener })).with(devTools((d, { config }) => d.config(config.devtools))),
        ),
      )
      .server(() => ({ listener })) as WebApplication
    await app.bootstrap()

    expect((await get(app, '/ops-tools')).status).toBe(200)
    expect((await get(app, '/devtools')).status).toBe(404)
  })

  it('serves the index at the root of its server under "/"', async () => {
    app = target({ devtools: d => d.path('/').slices(info()) })
    await app.bootstrap()

    const index = (await (await get(app, '/')).json()) as DevToolsIndex

    expect(index.slices).toEqual([{ id: 'info', href: '/info' }])
    expect((await get(app, '/info')).status).toBe(200)
  })

  it.each<[string, (d: DevToolsBuilder) => DevToolsBuilder, RegExp]>([
    [
      'a path that does not start with "/"',
      d => d.path('devtools'),
      /^Cannot serve DevTools at "devtools": the path does not start with "\/"/,
    ],
    [
      'a slice id that is not lower-case letters, digits and "-"',
      d => d.slices({ id: 'Bad_Id', router: () => new Router() }),
      /^Cannot serve DevTools slice "Bad_Id": the id is not lower-case letters, digits and "-"/,
    ],
    ['two slices sharing an id', d => d.slices(info(), info()), /^Cannot serve DevTools slice "info" twice/],
    [
      'public() alongside authorize(...)',
      d => d.public().authorize({ roles: ['operator'] }),
      /^Cannot serve DevTools: both "authorize\(\.\.\.\)" and "public\(\)" were called/,
    ],
  ])('refuses %s at start-up', async (_, configure, message) => {
    app = target({ devtools: configure })

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_DEVTOOLS_CONFIGURATION',
      message: expect.stringMatching(message),
    })
  })

  // A reader describing a server's API, an OpenAPI document for one, leaves an internal group out.
  it('marks every group it mounts internal, each named for its slice', async () => {
    app = target()
    await app.bootstrap()

    const groups = app.routeGroups.filter(group => group.boundTo === 'devtools')

    expect(groups.map(group => group.name)).toEqual([
      'devtools',
      'devtools:bindings',
      'devtools:graph',
      'devtools:routes',
      'devtools:health',
      'devtools:info',
      'devtools:configuration',
    ])

    for (const group of groups) {
      expect(group.detail?.http?.internal, group.name).toBe(true)
    }
  })

  // Mounted on the server it is registered on: the application's own server, and its public port, never answer for it.
  it("is served on the server it is registered on, and not on the application's own", async () => {
    app = target()
    await app.bootstrap()

    expect((await get(app, '/devtools')).status).toBe(200)
    expect((await app.fetch('/devtools')).status).toBe(404)
    expect((await app.fetch('/devtools/info')).status).toBe(404)
  })
})
