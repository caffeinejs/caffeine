import { Key } from './key.js'

/**
 * DeferredCtor wraps a deferred key resolution.
 */
export class DeferredCtor<T> {
  private static readonly _handler: ProxyHandler<() => unknown> = {
    apply: (t, thisArg, args) => Reflect.apply(t() as Function, thisArg, args),
    construct: (t, args, newTarget) => Reflect.construct(t() as any, args, newTarget),
    defineProperty: (t, p, d) => Reflect.defineProperty(t() as object, p, d),
    deleteProperty: (t, p) => Reflect.deleteProperty(t() as object, p),
    get: (t, p, r) => Reflect.get(t() as object, p, r),
    getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(t() as object, p),
    getPrototypeOf: t => Reflect.getPrototypeOf(t() as object),
    has: (t, p) => Reflect.has(t() as object, p),
    isExtensible: t => Reflect.isExtensible(t() as object),
    ownKeys: t => Reflect.ownKeys(t() as object),
    preventExtensions: t => Reflect.preventExtensions(t() as object),
    set: (t, p, v, r) => Reflect.set(t() as object, p, v, r),
    setPrototypeOf: (t, proto) => Reflect.setPrototypeOf(t() as object, proto),
  }

  constructor(private readonly callback: () => Key<T>) {}

  createProxy(creator: (ctor: Key<T>) => T): T {
    let init = false
    let value: T

    const deferredObject = (): T => {
      if (!init) {
        value = creator(this.unwrap())
        init = true
      }
      return value
    }

    return new Proxy<any>(deferredObject, DeferredCtor._handler)
  }

  unwrap(): Key<T> {
    return this.callback()
  }
}
