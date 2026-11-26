import { Injectable } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { corsPolicy } from '../core/cors/cors.js'
import {
  Controller,
  Get,
  HTTPPlugin,
  type HTTPSetupContext,
  type IContext,
  OnRequest,
  Prefix,
  RouteOptions,
  Router,
  UseGuards,
  Use,
  type Guard,
} from '../index.js'
import { node } from '../platform/node.testkit.js'

/**
 * Scenario: a controller's plugins — mounting routers, which nest under the controller as a router nested in a router
 * does under its parent, and answering preflights. In a file of its own: every application built here picks up these
 * classes.
 */

class Mounting extends HTTPPlugin {
  register({ server }: HTTPSetupContext): void {
    server.mount(new Router('/x').get('/', () => ({ mounted: true })))
  }
}

@Injectable()
class Refusing implements Guard {
  guard(): boolean {
    return false
  }
}

@Use(() => new Mounting())
@Controller('/mounting')
class MountingController {
  @Get('/')
  get() {
    return {}
  }
}

@UseGuards(Refusing)
@Use(() => new Mounting())
@Controller('/guarded')
class GuardedController {
  @Get('/')
  get() {
    return {}
  }
}

@Use(corsPolicy(c => c.origins('https://app.example')))
@Controller('/cors')
class CORSController {
  @Get('/')
  get() {
    return {}
  }
}

@Use(() => new Mounting())
@Controller('/hooked')
class HookedController {
  @OnRequest()
  stamp(ctx: IContext): void {
    ctx.header('x-controller-hook', 'ran')
  }

  @Get('/')
  get() {
    return {}
  }
}

const prefixes: string[] = []

class Recording extends HTTPPlugin {
  register({ server }: HTTPSetupContext): void {
    prefixes.push(server.prefix)
    server.mount(new Router('/x').get('/', () => ({ mounted: true })))
  }
}

@Prefix('/v1/')
@Use(() => new Recording())
@Controller('/prefixed')
class PrefixedController {
  @Get('/')
  get() {
    return {}
  }
}

let configured = 0

@RouteOptions(() => {
  configured++
})
@Use(() => new Mounting())
@Controller('/configured')
class ConfiguredController {
  @Get('/')
  get() {
    return {}
  }
}

void [MountingController, GuardedController, CORSController, HookedController, PrefixedController, ConfiguredController]

describe('HTTPPlugin on a controller, mounting', () => {
  it("serves what a controller's plugin mounts under the controller's path", async () => {
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()
      const res = await app.request('/mounting/x')

      expect([res.status, await res.json()]).toEqual([200, { mounted: true }])
    } finally {
      await app.close()
    }
  })

  // What it mounts starts from the controller's declarations, its guards included, as a nested router's would.
  it("keeps the controller's guards in front of what its plugin mounts", async () => {
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()

      expect((await app.request('/guarded/x')).status).toBe(403)
    } finally {
      await app.close()
    }
  })

  // CORS registers its preflight route in the controller's scope, as on a router.
  it("answers a preflight to a controller's routes from a policy on the controller", async () => {
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()
      const res = await app.request('/cors', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
      })

      expect([res.status, res.headers.get('access-control-allow-origin')]).toEqual([204, 'https://app.example'])
    } finally {
      await app.close()
    }
  })

  // A trailing slash on a controller's prefix is not a segment: its scope starts where its routes do.
  it('scopes a controller at its prefix and path when the prefix ends in a slash', async () => {
    prefixes.length = 0
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()

      expect(prefixes).toEqual(['/v1/prefixed'])
      expect((await app.request('/v1/prefixed/x')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // A configurer runs once per place: what a controller's plugin mounts reuses the controller's own options.
  it("runs a controller's configurer once when its plugin mounts a router under it", async () => {
    configured = 0
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()

      expect(configured).toBe(1)
      expect((await app.request('/configured/x')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // A controller's hook method covers every route under it, the routers its plugins mount included.
  it("runs the controller's hook methods in front of what its plugin mounts", async () => {
    const app = createWebApplication({ adapter: node() })

    try {
      await app.bootstrap()

      expect((await app.request('/hooked/x')).headers.get('x-controller-hook')).toBe('ran')
    } finally {
      await app.close()
    }
  })
})
