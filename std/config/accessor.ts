import { ErrConfig } from './errors.js'
import type { FeatureConfigKey } from './feature_key.js'

/**
 * The read-only projection of a config type.
 *
 * Arrays are matched as `readonly (infer U)[]`, not `Array<infer U>`: the latter misses a field already
 * declared `readonly string[]`, and misses `string[] | undefined` entirely (a union matches neither branch and
 * falls through unchanged — mutable). Distributing over the union keeps an optional array an array, and object
 * elements are projected too, so `Server[]` does not hand back mutable `Server`s inside a read-only list.
 */
export type ConfigAccessors<T> = {
  readonly [K in keyof T]: ConfigValueOf<T[K]>
}

type ConfigValueOf<V> = V extends readonly (infer U)[]
  ? ReadonlyArray<ConfigValueOf<U>>
  : V extends (...args: never[]) => unknown
    ? V
    : V extends object
      ? ConfigAccessors<V>
      : V

/** Answers a feature key with that feature's configuration, or `undefined` when nothing registered it. */
export type FeatureConfigLookup = (key: symbol) => unknown

/**
 * The root of a config tree: the application's own shape, plus the call that reads a feature's configuration
 * by {@link FeatureConfigKey}.
 *
 * A call rather than a member, because every member name is one an application could have declared in its own
 * configuration — the collision {@link Configuration.snapshot} is deliberately kept off the tree to avoid. Only
 * the root is callable; a nested node is a plain {@link ConfigAccessors} projection.
 */
export type ConfigHandle<T> = ConfigAccessors<T> & {
  <F>(key: FeatureConfigKey<F>): F | undefined
}

/**
 * A live view of a validated config tree.
 *
 * The tree is deep-frozen and replaced wholesale by a refresh, so this never needs to copy anything to stay
 * safe: nested objects are memoised proxies with stable identity, and arrays are handed back exactly as they
 * are held. After the first touch of a given path, a read is a revision comparison plus a property lookup —
 * nothing is constructed, which matters because this is read on request paths.
 *
 * `revision` is what makes the memo sound: it changes only when a refresh actually re-resolved, so a refresh
 * that found nothing to reload does not even invalidate the cache. Omitted, the memo is disabled and every
 * read goes back to `source` — which is what a caller swapping the backing object by hand needs.
 *
 * `features` answers a {@link FeatureConfigKey} passed to the handle itself. Only the root node takes one, so
 * only the root is callable.
 */
export function createLiveAccessors<T>(
  source: () => T,
  revision?: () => number,
  features?: FeatureConfigLookup,
): ConfigHandle<T> {
  return buildNode(source, revision, features) as ConfigHandle<T>
}

function buildNode<T>(source: () => T, revision: (() => number) | undefined, features?: FeatureConfigLookup): unknown {
  const children = new Map<string, unknown>()
  let stamp: number | undefined
  let target: unknown

  const resolve = (): unknown => {
    if (revision === undefined) {
      return source()
    }
    const current = revision()
    if (current !== stamp) {
      stamp = current
      target = source()
    }
    return target
  }

  const read = (prop: string): unknown => {
    const node = resolve()
    if (node === null || typeof node !== 'object') {
      return undefined
    }

    const value = (node as Record<string, unknown>)[prop]

    // Arrays and primitives pass straight through: the tree is frozen, so there is nothing to defend against
    // and nothing to copy. Only a nested object needs a node of its own, and that node is built once.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }

    let child = children.get(prop)
    if (child === undefined) {
      child = buildNode(() => (resolve() as Record<string, unknown>)[prop], revision)
      children.set(prop, child)
    }
    return child
  }

  const keys = (): string[] => {
    const node = resolve()
    return node !== null && typeof node === 'object' ? Object.keys(node) : []
  }

  // An arrow function where the node has to answer a feature key, so the handle can be called. It must be an
  // arrow: a function *declaration* carries a non-configurable own `prototype`, which `ownKeys` would then be
  // obliged to report, and the tree's own keys are the only ones that may appear there. `length` and `name`
  // are configurable, so leaving them out is allowed.
  const carrier: object = features === undefined ? {} : () => undefined

  return new Proxy(carrier, {
    apply(_t, _this, args: unknown[]) {
      return features?.(args[0] as symbol)
    },
    get(_t, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }

      // A callable target is a function to `JSON.stringify`, which skips it — so the root would serialize to
      // nothing without this. Only when the configuration does not declare `toJSON` itself.
      if (features !== undefined && prop === 'toJSON' && !keys().includes(prop)) {
        return () => resolve()
      }

      return read(prop)
    },
    set(_t, prop) {
      throw new ErrConfig(
        `Cannot assign to read-only config property "${String(prop)}"`,
        'ERR_CONFIG_READ_ONLY',
        undefined,
        'Change the value at its source and refresh the configuration, rather than writing to the handle',
      )
    },
    ownKeys() {
      return keys()
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== 'string' || !keys().includes(prop)) {
        return undefined
      }
      return { configurable: true, enumerable: true, writable: false, value: read(prop) }
    },
    has(_t, prop) {
      return typeof prop === 'string' && keys().includes(prop)
    },
  })
}
