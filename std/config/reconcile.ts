import { isForbiddenKey, isPlainObject } from './tree.js'

/**
 * Returns `next`, reusing every subtree of `previous` that is deep-equal to its counterpart, and appends to
 * `changed` the dotted path of every value that differs.
 *
 * `previous` itself comes back when nothing differs. Otherwise only the objects along a changed path are new, so
 * a subtree that did not change keeps its identity, and identity is enough to tell whether it changed.
 *
 * Arrays are values: one that differs is reported once, at its own path, and comes back as `next` holds it.
 * Anything that is neither a plain object nor an array is compared by identity alone.
 */
export function reconcile<T>(previous: unknown, next: T, changed?: string[], path = ''): T {
  if (Object.is(previous, next)) {
    return previous as T
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    if (
      previous.length === next.length &&
      next.every((element, i) => reconcile(previous[i], element) === previous[i])
    ) {
      return previous as T
    }

    changed?.push(path)
    return next
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    return reconcileObject(previous, next, changed, path) as T
  }

  changed?.push(path)
  return next
}

function reconcileObject(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  changed: string[] | undefined,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let same = true

  for (const key of Object.keys(next)) {
    if (isForbiddenKey(key)) {
      continue
    }

    const childPath = path === '' ? key : `${path}.${key}`

    if (!Object.hasOwn(previous, key)) {
      changed?.push(childPath)
      out[key] = next[key]
      same = false
      continue
    }

    const value = reconcile(previous[key], next[key], changed, childPath)
    if (value !== previous[key]) {
      same = false
    }
    out[key] = value
  }

  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key) && !isForbiddenKey(key)) {
      changed?.push(path === '' ? key : `${path}.${key}`)
      same = false
    }
  }

  return same ? previous : out
}
