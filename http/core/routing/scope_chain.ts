import type { RouteGroupScope } from './route.js'

interface ChainNode<V> {
  readonly children: Map<object, ChainNode<V>>
  set: boolean
  value: V | undefined
}

/**
 * Values kept per mount chain: a router or a controller with every router it is nested in, outermost first, as a
 * group's `scopes` lists them. One router under two parents is two chains, even at one path; the same router mounted
 * twice under one parent is one.
 */
export class ScopeChains<V> {
  readonly #root: ChainNode<V> = { children: new Map(), set: false, value: undefined }

  /** Whether a value is kept for the chain `scopes[0..at]`. */
  has(scopes: readonly RouteGroupScope[], at = scopes.length - 1): boolean {
    return this.#node(scopes, at, false)?.set === true
  }

  /** The value kept for the chain `scopes[0..at]`, `undefined` when none is. */
  get(scopes: readonly RouteGroupScope[], at = scopes.length - 1): V | undefined {
    return this.#node(scopes, at, false)?.value
  }

  /** The value kept for the chain `scopes[0..at]`, made with `create` the first time it is asked for. */
  at(scopes: readonly RouteGroupScope[], create: () => V, at = scopes.length - 1): V {
    const node = this.#node(scopes, at, true)!
    if (!node.set) {
      node.value = create()
      node.set = true
    }

    return node.value as V
  }

  #node(scopes: readonly RouteGroupScope[], at: number, create: boolean): ChainNode<V> | undefined {
    let node = this.#root
    for (let i = 0; i <= at; i++) {
      const key = scopes[i]!.key
      let next = node.children.get(key)
      if (next === undefined) {
        if (!create) {
          return undefined
        }

        next = { children: new Map(), set: false, value: undefined }
        node.children.set(key, next)
      }

      node = next
    }

    return node
  }
}
