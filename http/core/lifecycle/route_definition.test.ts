import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import type { IRoute, IRouteGroup } from '../routing/route.js'
import { HookBatch } from './batch.js'
import { callOnRoute, openDefinition } from './route_definition.js'

declare module '../routing/options.js' {
  interface RouteOptions {
    testOpened?: boolean
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
