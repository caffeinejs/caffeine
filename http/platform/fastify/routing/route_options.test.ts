import { describe, it, expect } from 'vitest'

import { addRouteHook, type AdapterRouteOptions } from './route_options.js'

const newRouteDef = (): AdapterRouteOptions =>
  ({ method: 'GET', url: '/', handler: () => undefined }) as unknown as AdapterRouteOptions

const a = (): void => {}
const b = (): void => {}
const c = (): void => {}

describe('addRouteHook', () => {
  it('writes the function directly into an empty slot, allocating no array', () => {
    const routeDef = newRouteDef()

    addRouteHook(routeDef, 'onRequest', a as never)

    expect(routeDef.onRequest).toBe(a)
  })

  it('promotes to a two-element array on the second write', () => {
    const routeDef = newRouteDef()

    addRouteHook(routeDef, 'onRequest', a as never)
    addRouteHook(routeDef, 'onRequest', b as never)

    expect(routeDef.onRequest).toEqual([a, b])
  })

  // Fastify clones route options shallowly for a GET route's HEAD twin, so an array in a slot is shared with it:
  // a push would land the hook on both routes, and the twin would then add its own copy on top.
  it('replaces the array from the third write on, leaving the earlier one as it was', () => {
    const routeDef = newRouteDef()

    addRouteHook(routeDef, 'onSend', a as never)
    addRouteHook(routeDef, 'onSend', b as never)
    const array = routeDef.onSend
    addRouteHook(routeDef, 'onSend', c as never)

    expect(array).toEqual([a, b])
    expect(routeDef.onSend).toEqual([a, b, c])
  })

  it('does not mutate an array the route declared itself', () => {
    const routeDef = newRouteDef()
    const declared = [a, b]
    routeDef.onSend = declared as never

    addRouteHook(routeDef, 'onSend', c as never)

    expect(declared).toEqual([a, b])
    expect(routeDef.onSend).toEqual([a, b, c])
  })

  it('preserves a hook the route declared itself, and keeps it first', () => {
    const routeDef = newRouteDef()
    routeDef.onRequest = a as never

    addRouteHook(routeDef, 'onRequest', b as never)

    expect(routeDef.onRequest).toEqual([a, b])
  })

  it('appends to an array the route declared itself', () => {
    const routeDef = newRouteDef()
    routeDef.onSend = [a, b] as never

    addRouteHook(routeDef, 'onSend', c as never)

    expect(routeDef.onSend).toEqual([a, b, c])
  })

  it('leaves the other slots untouched', () => {
    const routeDef = newRouteDef()

    addRouteHook(routeDef, 'onRequest', a as never)

    expect(routeDef.onSend).toBeUndefined()
  })
})
