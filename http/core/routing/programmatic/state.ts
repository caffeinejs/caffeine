import type { ObjectInjectionSpec } from '@caffeinejs/di'

import type { HTTPPluginFactory } from '../../../plugin.js'
import type { RouteBuilder, RouteGroupBuilder } from '../builder.js'
import type { RouteInvoker } from '../spec.js'

/**
 * The authored state of one route, as the fluent chain accumulates it.
 *
 * Config goes straight into the same {@link RouteBuilder} the decorators fill, so the two authoring styles cannot
 * drift: whatever a decorator can express, the chain expresses by calling the same method.
 */
export interface RouteState {
  readonly builder: RouteBuilder
  readonly method: string[]
  readonly path: string
  injection?: ObjectInjectionSpec
  handle?: RouteInvoker
  named: boolean
}

/** The authored state of one group: its own config, its routes, and the groups nested under it. */
export interface RouterState {
  readonly builder: RouteGroupBuilder
  /** Its path as mounted: the path given to `mount(path, ...)`, then its own. */
  readonly path: string
  /** The path given to `mount(path, ...)`: where it is mounted under its parent, ahead of its group prefix. */
  readonly at?: string
  name?: string
  injection?: ObjectInjectionSpec
  readonly routes: RouteState[]
  readonly children: RouterState[]
  /** The factories `.with(...)` registered on this router, in the order they were written. */
  readonly plugins: HTTPPluginFactory[]
}

// Kept off the classes so nothing internal shows up on the public type, and so `flatten` can read a whole tree
// without every node exposing a way to mutate it.
const states = new WeakMap<object, RouterState>()

export function attachState(router: object, state: RouterState): void {
  states.set(router, state)
}

export function stateOf(router: object): RouterState | undefined {
  return states.get(router)
}
