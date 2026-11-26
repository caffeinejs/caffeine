import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { IRoute, IRouteGroup } from '../routing/route.js'
import { HookBatch } from './batch.js'
import { callOnRoute, openDefinition } from './route_definition.js'

declare module '../routing/options.js' {
  interface RouteOptions {
    testOpened?: boolean
    testWritten?: string
  }
}

const route = { options: { testOpened: true } } as unknown as IRoute
const group = {} as IRouteGroup
const kit = {} as HTTPSetupContext

describe('openDefinition', () => {
  it('hands the route its options and records the hooks added while open', () => {
    const open = openDefinition(route, group, ['GET'], '/pets')
    const hook = (): void => undefined

    open.definition.hook('onSend', hook).hook('onSend', hook)

    expect(open.definition.options.testOpened).toBe(true)
    expect(open.added.onSend).toEqual([hook, hook])
  })

  // A hook added after the route was installed would never run: refused so the plugin finds out.
  it('refuses a hook once onRoute has returned', () => {
    const open = openDefinition(route, group, ['GET', 'POST'], '/pets')
    open.close()

    expect(() => open.definition.hook('onRequest', () => undefined)).toThrow(ErrConfiguration)
    expect(() => open.definition.hook('onRequest', () => undefined)).toThrow(
      'Cannot add a hook to "GET|POST /pets": onRoute has returned',
    )
  })

  // What a hook writes is this route's on this server: the compiled route, which every server shares, keeps its own.
  it('hands each definition a copy of the route options to write', () => {
    const open = openDefinition(route, group, ['GET'], '/pets')

    open.definition.options.testWritten = 'here'

    expect(open.definition.options).toEqual({ testOpened: true, testWritten: 'here' })
    expect(route.options).toEqual({ testOpened: true })
  })

  // Read on every request: a write after start-up would change a route's setting under requests in flight.
  it('freezes the options once onRoute has returned', () => {
    const open = openDefinition(route, group, ['GET'], '/pets')
    open.close()

    expect(() => {
      open.definition.options.testWritten = 'late'
    }).toThrow(TypeError)
  })

  it('refuses a point that is not a request hook', () => {
    const open = openDefinition(route, group, ['GET'], '/pets')

    expect(() => open.definition.hook('onRoute' as 'onRequest', () => undefined)).toThrow(
      'Use one of "onRequest", "preHandler", "onSend", "onResponse", "onError"',
    )
  })
})

describe('callOnRoute', () => {
  it('calls each batch in order with its own context', () => {
    const seen: string[] = []
    const first = new HookBatch({ name: 'first' } as unknown as HTTPSetupContext)
    const second = new HookBatch({ name: 'second' } as unknown as HTTPSetupContext)
    first.add('onRoute', (_route, k) => void seen.push((k as unknown as { name: string }).name))
    second.add('onRoute', (_route, k) => void seen.push((k as unknown as { name: string }).name))

    callOnRoute([first, second], openDefinition(route, group, ['GET'], '/pets').definition)

    expect(seen).toEqual(['first', 'second'])
  })

  // Nothing waits on onRoute: a promise would let a route serve before the hook finished with it.
  it('refuses an onRoute that returns a promise', () => {
    const batch = new HookBatch(kit)
    batch.add('onRoute', (async () => undefined) as unknown as () => void)

    expect(() => callOnRoute([batch], openDefinition(route, group, ['GET'], '/pets').definition)).toThrow(
      'Cannot run the onRoute hook for "GET /pets": it returned a promise',
    )
  })
})

describe('route options written in onRoute', () => {
  class Writing extends HTTPPlugin {
    register({ server }: HTTPSetupContext): void {
      server.hook('onRoute', route => {
        route.options.testWritten = 'written'
      })
    }
  }

  class Reading extends HTTPPlugin {
    constructor(readonly seen: unknown[]) {
      super()
    }

    register({ server }: HTTPSetupContext): void {
      server.hook('onRoute', route => void this.seen.push(route.options.testWritten))
    }
  }

  // How a plugin keeps a setting per route without a map of its own: the request reads it back.
  it('reaches the request through ctx.options', async () => {
    const app = createWebApplication()
      .with(() => new Writing())
      .mount(new Router('/w').get('/', ctx => ({ written: ctx.options.testWritten ?? null })))

    try {
      await app.bootstrap()

      expect(await (await app.request('/w')).json()).toEqual({ written: 'written' })
    } finally {
      await app.close()
    }
  })

  it("is seen by a later plugin's onRoute", async () => {
    const seen: unknown[] = []
    const app = createWebApplication()
      .with(() => new Writing())
      .with(() => new Reading(seen))
      .mount(new Router('/w').get('/', () => 'ok'))

    try {
      await app.bootstrap()

      expect(seen).toEqual(['written'])
    } finally {
      await app.close()
    }
  })
})
