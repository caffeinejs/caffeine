import { DeferredCtor } from '@caffeinejs/core'
import type { Key, Snapshot } from '@caffeinejs/core'

export function resolveKey(key: Key): Key {
  return key instanceof DeferredCtor ? key.unwrap() : key
}

export function exclusiveDeps(snap: Snapshot, isolatedKeys: Set<Key>): Set<Key> {
  const forward = buildForwardMap(snap)
  const reverse = new Map<Key, Set<Key>>()

  for (const [k, deps] of forward) {
    for (const dep of deps) {
      if (!reverse.has(dep)) {
        reverse.set(dep, new Set())
      }
      reverse.get(dep)!.add(k)
    }
  }

  const candidates = new Set<Key>()
  const queue: Key[] = [...isolatedKeys].flatMap(k => [...(forward.get(k) ?? [])])
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!
    if (!candidates.has(k) && !isolatedKeys.has(k)) {
      candidates.add(k)
      for (const dep of forward.get(k) ?? []) {
        queue.push(dep)
      }
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const k of [...candidates]) {
      const dependents = reverse.get(k) ?? new Set<Key>()
      const hasExternalDependent = [...dependents].some(d => !candidates.has(d) && !isolatedKeys.has(d))
      if (hasExternalDependent) {
        candidates.delete(k)
        changed = true
      }
    }
  }

  return candidates
}

export function allTransitiveDeps(snap: Snapshot, roots: Set<Key>): Set<Key> {
  const forward = buildForwardMap(snap)
  const result = new Set<Key>()
  const queue: Key[] = [...roots].flatMap(k => [...(forward.get(k) ?? [])])
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!
    if (!result.has(k) && !roots.has(k)) {
      result.add(k)
      for (const dep of forward.get(k) ?? []) {
        queue.push(dep)
      }
    }
  }
  return result
}

function buildForwardMap(snap: Snapshot): Map<Key, Set<Key>> {
  const forward = new Map<Key, Set<Key>>()

  for (const [k, b] of snap.entries()) {
    const deps = new Set<Key>()
    for (const d of b.injections) {
      if (d.key) {
        deps.add(resolveKey(d.key))
      }
    }
    for (const d of b.injectableProperties.values()) {
      if (d.key) {
        deps.add(resolveKey(d.key))
      }
    }
    for (const ds of b.injectableMethods.values()) {
      for (const d of ds) {
        if (d.key) {
          deps.add(resolveKey(d.key))
        }
      }
    }
    if (b.source?.ctor) {
      deps.add(b.source.ctor)
    }
    forward.set(k, deps)
  }

  return forward
}
