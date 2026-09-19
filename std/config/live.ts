import { isForbiddenKey, isPlainObject } from './tree.js'
import type { ConfigSnapshot, LiveConfig } from './types.js'

// One live node per plain-object node of the snapshot. Every property is a read-only data property: a leaf holds
// the current value, and an object-valued key holds the child node, which never changes. A swap walks the old and
// the new snapshot side by side and rewrites a property only where its value changed.
//
// Not accessors: V8 keeps a getter in the hidden class, so a node repeating the keys of another, with getters of its
// own, cannot share it and falls into dictionary mode. Data properties with the same keys share a hidden class.

type SnapshotNode = Readonly<Record<string, unknown>>

// The snapshot each live config object mirrors, by its root.
const snapshotOf = new WeakMap<object, SnapshotNode>()

// What a node whose path stopped holding an object mirrors: nothing.
const EMPTY: SnapshotNode = Object.freeze({})

/** Builds the live config object over a snapshot whose root is a plain object. */
export function createLive<T>(snapshot: ConfigSnapshot<T>): LiveConfig<T> {
  const root = createNode(snapshot as SnapshotNode)
  snapshotOf.set(root, snapshot as SnapshotNode)
  return root as LiveConfig<T>
}

/**
 * Points the live config object at `next`. A subtree of `next` that is the same object as before is skipped with
 * one comparison, so the work is proportional to what changed.
 */
export function syncLive(live: object, next: object): void {
  sync(live, snapshotOf.get(live)!, next as SnapshotNode)
  snapshotOf.set(live, next as SnapshotNode)
}

function createNode(snapshotNode: SnapshotNode): object {
  const node = {}
  for (const key of Object.keys(snapshotNode)) {
    if (!isForbiddenKey(key)) {
      define(node, key, snapshotNode[key])
    }
  }
  return node
}

function define(node: object, key: string, value: unknown): void {
  Object.defineProperty(node, key, { value: nodeOf(value), enumerable: true, configurable: true, writable: false })
}

// A key the node already has keeps the attributes it was defined with.
function rewrite(node: object, key: string, value: unknown): void {
  Object.defineProperty(node, key, { value: nodeOf(value) })
}

function nodeOf(value: unknown): unknown {
  return isPlainObject(value) ? createNode(value) : value
}

function sync(node: object, previous: SnapshotNode, next: SnapshotNode): void {
  if (previous === next) {
    return
  }

  const children = node as Readonly<Record<string, object>>
  let kept = 0

  for (const key of Object.keys(next)) {
    if (isForbiddenKey(key)) {
      continue
    }

    const value = next[key]

    if (!Object.hasOwn(previous, key)) {
      define(node, key, value)
      continue
    }

    kept++
    const before = previous[key]

    if (Object.is(before, value)) {
      continue
    }

    if (isPlainObject(before)) {
      if (isPlainObject(value)) {
        sync(children[key], before, value)
        continue
      }
      // An object that became a leaf. The old node is emptied, not left serving its last values.
      sync(children[key], before, EMPTY)
    }

    rewrite(node, key, value)
  }

  const keys = Object.keys(previous)

  // Every key of the previous snapshot is still there, so nothing went away.
  if (kept === keys.length) {
    return
  }

  for (const key of keys) {
    if (Object.hasOwn(next, key) || isForbiddenKey(key)) {
      continue
    }

    const before = previous[key]
    if (isPlainObject(before)) {
      // An orphaned node is emptied, not left serving its last values.
      sync(children[key], before, EMPTY)
    }
    delete (node as Record<string, unknown>)[key]
  }
}
