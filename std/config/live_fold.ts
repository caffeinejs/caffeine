import { configEquals } from './notifier.js'

/**
 * An object with a stable identity whose fields are folded from settings that may still move.
 *
 * A feature usually cannot hand out its configuration as-is: durations have to be normalized, defaults folded
 * in, a dispatcher or a handler merged alongside. Doing that once at bootstrap freezes the result, so a
 * refresh never reaches whatever was handed the object. Doing it per read is live but recomputes constantly,
 * and a fold with a side effect — a warning about an impossible budget — would repeat it on every property.
 *
 * This does both: `inputs` is re-read on each access and compared with {@link configEquals}, and `fold` runs
 * only when the answer actually changed. What comes back can therefore be bound by value and still follow a
 * refresh.
 *
 * ```ts
 * const policy = liveFold(
 *   () => ({ timeout: config.timeout ?? this.#timeout }),
 *   raw => finalize(merge(raw, { dispatcher })),
 * )
 * ```
 *
 * `inputs` must return the raw settings rather than the folded result: it is what "unchanged" is measured on,
 * so it has to be cheap and free of side effects.
 */
export function liveFold<I, O extends object>(inputs: () => I, fold: (inputs: I) => O): O {
  let last: I | undefined
  let value: O | undefined

  const resolve = (): O => {
    const next = inputs()

    if (value === undefined || !configEquals(next, last)) {
      last = next
      value = fold(next)
    }

    return value
  }

  return new Proxy({} as O, {
    get(_target, prop) {
      return (resolve() as Record<PropertyKey, unknown>)[prop]
    },
    ownKeys() {
      return Reflect.ownKeys(resolve())
    },
    // The target is an empty object, so a descriptor reported for a key it does not have must be configurable
    // or the proxy invariants reject it.
    getOwnPropertyDescriptor(_target, prop) {
      const current = resolve()
      if (!(prop in current)) {
        return undefined
      }

      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: (current as Record<PropertyKey, unknown>)[prop],
      }
    },
    has(_target, prop) {
      return prop in resolve()
    },
  })
}
