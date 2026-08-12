export type ConfigAccessors<T> = {
  readonly [K in keyof T]: T[K] extends Array<infer U>
    ? ReadonlyArray<U>
    : T[K] extends object
      ? ConfigAccessors<T[K]>
      : T[K]
}

export type ConfigHandle<T> = ConfigAccessors<T>

export function createLiveAccessors<T>(source: () => T): ConfigHandle<T> {
  return buildNode(source) as ConfigHandle<T>
}

function buildNode<T>(source: () => T): unknown {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      const val = (source() as Record<string, unknown>)[prop]
      if (Array.isArray(val)) {
        return Object.freeze([...val])
      }
      if (val !== null && typeof val === 'object') {
        return buildNode(() => (source() as Record<string, unknown>)[prop])
      }
      return val
    },
    set(_t, prop) {
      throw new TypeError(`Cannot assign to read-only config property "${String(prop)}"`)
    },
    ownKeys() {
      const s = source()
      return s !== null && typeof s === 'object' ? Object.keys(s) : []
    },
    getOwnPropertyDescriptor(_t, prop) {
      const s = source() as Record<string, unknown>
      if (typeof prop !== 'string' || s === null || typeof s !== 'object' || !(prop in s)) {
        return undefined
      }
      const val = s[prop]
      const value = val !== null && typeof val === 'object' && !Array.isArray(val)
        ? buildNode(() => (source() as Record<string, unknown>)[prop])
        : Array.isArray(val)
          ? Object.freeze([...val])
          : val
      return { configurable: true, enumerable: true, writable: false, value }
    },
    has(_t, prop) {
      const s = source()
      return typeof prop === 'string' && s !== null && typeof s === 'object' && prop in (s as object)
    },
  })
}
