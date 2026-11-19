import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import {
  Controller,
  Get,
  HTTPPlugin,
  Router,
  type HTTPSetupContext,
  type IRoute,
  type IRouteGroup,
  type WebApplication,
} from '../index.js'
import { node } from '../platform/node.testkit.js'

/**
 * A plugin learns the application's routes from `onRoute`, and finds what Caffeine compiled on the route and its
 * group. There is no route table decorated on the server, so if the metadata stops being handed over, nothing else
 * can supply it and these fail.
 */

@Controller('/meta-controller')
class MetaController {
  @Get('/hello')
  hello() {
    return { ok: true }
  }
}
void [MetaController]

interface Seen {
  methods: readonly string[]
  url: string
  route: Readonly<IRoute<unknown>>
  group: Readonly<IRouteGroup<unknown>>
}

/** Records every route registered after it, with the route and group it was compiled from. */
class Observer extends HTTPPlugin {
  override readonly name = 'observer'

  constructor(private readonly seen: Seen[]) {
    super()
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onRoute', route => {
      this.seen.push({ methods: route.methods, url: route.url, route: route.route, group: route.group })
    })
  }
}

function routerWithOneRoute(): Router {
  const router = new Router('/meta-router')
  router.get('/hello').handler(() => ({ ok: true }))
  return router
}

describe('route metadata on onRoute', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('reaches onRoute for decorated and programmatic routes', async () => {
    const seen: Seen[] = []
    app = createWebApplication({ adapter: node() })
      .with(() => new Observer(seen))
      .mount(routerWithOneRoute()) as WebApplication
    await app.bootstrap()

    const get = (url: string) => seen.find(s => s.url === url && s.methods.includes('GET'))

    expect(get('/meta-controller/hello')?.group.target).toBe(MetaController)
    expect(get('/meta-controller/hello')?.route.name).toBe('hello')
    expect(get('/meta-router/hello')?.route.path).toBe('/hello')
  })
})
