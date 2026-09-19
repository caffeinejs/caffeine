/** Whether assigning `key` on a plain object could reach its prototype instead of creating a property. */
export function isForbiddenKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

/** Whether `value` is a plain object: an object literal, or an object with no prototype. Arrays are not. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value) as unknown

  return prototype === Object.prototype || prototype === null
}

/**
 * Freezes `value` and everything beneath it. A subtree that is already frozen is taken to be frozen all the way
 * down and is not walked again, which is what keeps freezing a reconciled tree proportional to what changed.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key])
  }

  return Object.freeze(value)
}

/**
 * Freezes `value` and everything beneath it like {@link freezeDeep}, but returns each plain object and array that
 * was not frozen yet as a frozen copy. A frozen subtree comes back as it is, and any other object is frozen in place.
 */
export function freezeCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeCopy)) as T
  }
  if (!isPlainObject(value)) {
    return freezeDeep(value)
  }

  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (!isForbiddenKey(key)) {
      copy[key] = freezeCopy(value[key])
    }
  }
  return Object.freeze(copy) as T
}

/**
 * A path given dotted or already split. A dotted path is split as a flat source's key is, by {@link splitKey}, and
 * has no escape, so a key holding a dot needs the array form.
 */
export function toParts(path: string | readonly string[]): readonly string[] {
  if (typeof path !== 'string') {
    return path
  }

  return path === '' ? [] : splitKey(path)
}

/** Splits a key on `.`, and splits `name[0][1]` into `name`, `0`, `1`. */
export function splitKey(key: string): string[] {
  const parts: string[] = []

  for (const piece of key.split('.')) {
    const match = BRACKETS.exec(piece)
    if (match === null) {
      parts.push(piece)
      continue
    }

    if (match[1] !== '') {
      parts.push(match[1])
    }
    for (const index of match[2].matchAll(INDEX_IN_BRACKETS)) {
      parts.push(index[1])
    }
  }

  return parts
}

const BRACKETS = /^([^[\]]*)((?:\[\d+\])+)$/
const INDEX_IN_BRACKETS = /\[(\d+)\]/g

/** Whether a path segment addresses an array element: an unsigned integer with no leading zero. */
export function isIndex(segment: string): boolean {
  return INDEX.test(segment)
}

const INDEX = /^(0|[1-9]\d*)$/

/** The value at `parts` in `tree`, or `undefined`. Only own properties are read, so no path reaches a prototype. */
export function readPath(tree: unknown, parts: readonly string[]): unknown {
  let node = tree

  for (const part of parts) {
    if (node === null || typeof node !== 'object') {
      return undefined
    }

    if (Array.isArray(node)) {
      if (!isIndex(part)) {
        return undefined
      }
      node = node[Number(part)]
    } else {
      node = Object.hasOwn(node, part) ? (node as Record<string, unknown>)[part] : undefined
    }
  }

  return node
}

/** How many settings `value` holds: every scalar, and every empty array, which is a setting of its own. */
export function countLeaves(value: unknown): number {
  if (isPlainObject(value)) {
    return sumLeaves(Object.values(value))
  }
  return Array.isArray(value) && value.length > 0 ? sumLeaves(value) : 1
}

function sumLeaves(values: readonly unknown[]): number {
  return values.reduce<number>((count, child) => count + countLeaves(child), 0)
}
