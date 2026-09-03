import { describe, it, expect } from 'vitest'

import { addRouteHook, type AdapterRouteOptions } from './route_hooks.js'

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

  it('pushes onto the existing array from the third write on', () => {
    const routeDef = newRouteDef()

    addRouteHook(routeDef, 'onSend', a as never)
    addRouteHook(routeDef, 'onSend', b as never)
    const array = routeDef.onSend
    addRouteHook(routeDef, 'onSend', c as never)

    expect(routeDef.onSend).toBe(array)
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
