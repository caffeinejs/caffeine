import { isForbiddenKey, isPlainObject } from './tree.js'

/**
 * The dotted path of every value that differs between `previous` and `next`. Empty exactly when the two are
 * deep-equal.
 *
 * Arrays are values: one that differs is reported once, at its own path. A key only one side holds is reported at
 * its own path. Anything that is neither a plain object nor an array is compared by identity alone.
 */
export function changedPaths(previous: unknown, next: unknown): string[] {
  const changed: string[] = []
  collect(previous, next, '', changed)
  return changed
}

function collect(previous: unknown, next: unknown, path: string, changed: string[]): void {
  if (Object.is(previous, next)) {
    return
  }

  if (!isPlainObject(previous) || !isPlainObject(next)) {
    if (!deepEquals(previous, next)) {
      changed.push(path)
    }
    return
  }

  for (const key of Object.keys(next)) {
    if (isForbiddenKey(key)) {
      continue
    }

    const childPath = path === '' ? key : `${path}.${key}`
    if (Object.hasOwn(previous, key)) {
      collect(previous[key], next[key], childPath, changed)
    } else {
      changed.push(childPath)
    }
  }

  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key) && !isForbiddenKey(key)) {
      changed.push(path === '' ? key : `${path}.${key}`)
    }
  }
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
