import { freezeCopy, isForbiddenKey, isPlainObject } from './tree.js'

/**
 * Returns `next` frozen as {@link freezeCopy} would, except that a subtree deep-equal to its counterpart in the
 * frozen tree `previous` is that counterpart, and appends to `changed` the dotted path of every value that differs.
 *
 * `previous` itself comes back exactly when nothing differs. Otherwise only the objects along a changed path are new,
 * so a subtree that did not change keeps its identity, and the result holds no copy of it.
 *
 * Arrays are values: one that differs is reported once, at its own path, and copied whole. A key only one side holds
 * is reported at its own path. Anything that is neither a plain object nor an array is compared by identity alone.
 */
export function reconcile<T>(previous: T, next: unknown, changed: string[], path = ''): T {
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    if (deepEquals(previous, next)) {
      return previous
    }

    changed.push(path)
    return freezeCopy(next) as T
  }

  const reported = changed.length
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(next)) {
    if (isForbiddenKey(key)) {
      continue
    }

    const childPath = path === '' ? key : `${path}.${key}`
    if (Object.hasOwn(previous, key)) {
      out[key] = reconcile(previous[key], next[key], changed, childPath)
    } else {
      changed.push(childPath)
      out[key] = freezeCopy(next[key])
    }
  }

  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key) && !isForbiddenKey(key)) {
      changed.push(path === '' ? key : `${path}.${key}`)
    }
  }

  // Nothing reported beneath means every key came back as `previous` holds it, and none was added or removed.
  return changed.length === reported ? previous : (Object.freeze(out) as T)
}

/** Whether two trees hold the same data, stopping at the first difference. */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((element, i) => deepEquals(element, b[i]))
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false
  }

  let keys = 0
  for (const key of Object.keys(b)) {
    if (isForbiddenKey(key)) {
      continue
    }
    if (!Object.hasOwn(a, key) || !deepEquals(a[key], b[key])) {
      return false
    }
    keys++
  }

  for (const key of Object.keys(a)) {
    if (!isForbiddenKey(key)) {
      keys--
    }
  }

  return keys === 0
}
