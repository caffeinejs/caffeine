import { countLeaves, isPlainObject, toParts } from '../tree.js'
import type { ConfigLayer, ConfigObject, ConfigSource, ConfigValue } from '../types.js'

/**
 * Configuration held in memory and written at run time. Every write reaches readers on its own: the store is told,
 * and reloads this source alone.
 *
 * A write owns only the paths it names, so a mutable source registered after the others overrides exactly those
 * paths and leaves the rest of the tree to them.
 */
export class MutableConfigSource implements ConfigSource {
  readonly name: string
  readonly live = true
  #data: Record<string, unknown> = {}
  #changed: (() => void) | undefined

  /** @param name - Defaults to `mutable`. */
  constructor(name = 'mutable') {
    this.name = name
  }

  /**
   * Sets the value at `path`, replacing whatever this source held there. A dotted path splits on `.`; a key
   * holding a dot needs the array form.
   */
  set(path: string | readonly string[], value: ConfigValue): this {
    const parts = toParts(path)
    if (parts.length === 0) {
      return this.replace(value as Record<string, ConfigValue>)
    }

    let node = this.#data
    for (const part of parts.slice(0, -1)) {
      const child = own(node, part)
      node = isPlainObject(child) ? child : put(node, part, {})
    }
    put(node, parts[parts.length - 1], structuredClone(value))

    return this.#written()
  }

  /** Merges `values` in: objects merge key by key, and anything else replaces what this source held. */
  merge(values: Record<string, ConfigValue>): this {
    mergeInto(this.#data, values)
    return this.#written()
  }

  /** Removes the value at `path` and everything beneath it. */
  unset(path: string | readonly string[]): this {
    const parts = toParts(path)
    let node: unknown = this.#data

    for (const part of parts.slice(0, -1)) {
      node = isPlainObject(node) ? own(node, part) : undefined
    }
    if (isPlainObject(node) && parts.length > 0) {
      delete node[parts[parts.length - 1]]
    }

    return this.#written()
  }

  /** Discards everything and starts over from `values`. */
  replace(values: Record<string, ConfigValue>): this {
    this.#data = structuredClone(values) as Record<string, unknown>
    return this.#written()
  }

  /** Whether this source holds no value at all. */
  get empty(): boolean {
    return countLeaves(this.#data) === 0
  }

  /** Each load gets its own copy, so a later write cannot change one already handed out. */
  load(): readonly ConfigLayer[] {
    return [{ name: this.name, data: structuredClone(this.#data) as ConfigObject }]
  }

  watch(changed: () => void): () => void {
    this.#changed = changed
    return () => {
      if (this.#changed === changed) {
        this.#changed = undefined
      }
    }
  }

  #written(): this {
    this.#changed?.()
    return this
  }
}

function own(node: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined
}

// `defineProperty`, not assignment: a key such as `__proto__` becomes an own property rather than a prototype
// change, and the store then refuses it where it can say so.
function put<V>(node: Record<string, unknown>, key: string, value: V): V {
  Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true })
  return value
}

function mergeInto(target: Record<string, unknown>, values: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(values)) {
    const next = values[key]
    const previous = own(target, key)

    if (isPlainObject(next) && isPlainObject(previous)) {
      mergeInto(previous, next)
    } else if (next !== undefined) {
      put(target, key, structuredClone(next))
    }
  }
}
