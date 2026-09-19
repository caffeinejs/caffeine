import { isForbiddenKey, isPlainObject } from './tree.js'
import type { ConfigSnapshot, LiveConfig } from './types.js'

// One live node per plain-object node of the snapshot. Every property is an accessor with no setter: a leaf reads
// its key off the holder, and an object-valued key returns the child node, which never changes. A swap repoints
// the holders and redefines a property only where the shape changed.

interface NodeState {
  readonly holder: { current: Readonly<Record<string, unknown>> }
  readonly children: Map<string, object>
}

const states = new WeakMap<object, NodeState>()

// What a node whose path stopped holding an object reads from: nothing.
const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({})

const kInspect = Symbol.for('nodejs.util.inspect.custom')

/** Builds the live config object over a snapshot whose root is a plain object. */
export function createLive<T>(snapshot: ConfigSnapshot<T>): LiveConfig<T> {
  return createNode(snapshot as Readonly<Record<string, unknown>>) as LiveConfig<T>
}

/**
 * Points the live config object at `next`. A subtree of `next` that is the same object as before is skipped with
 * one comparison, so the work is proportional to what changed.
 */
export function syncLive(live: object, next: object): void {
  sync(live, next as Readonly<Record<string, unknown>>)
}

function createNode(snapshotNode: Readonly<Record<string, unknown>>): object {
  const node = {}
  const state: NodeState = { holder: { current: snapshotNode }, children: new Map() }
  states.set(node, state)

  // `console.log` shows the values rather than a list of getters.
  Object.defineProperty(node, kInspect, { value: () => state.holder.current })

  for (const key of Object.keys(snapshotNode)) {
    define(node, state, key)
  }

  return node
}

function define(node: object, state: NodeState, key: string): void {
  if (isForbiddenKey(key)) {
    return
  }

  const value = state.holder.current[key]

  if (isPlainObject(value)) {
    const child = createNode(value)
    state.children.set(key, child)
    Object.defineProperty(node, key, { enumerable: true, configurable: true, get: () => child })
    return
  }

  const holder = state.holder
  Object.defineProperty(node, key, { enumerable: true, configurable: true, get: () => holder.current[key] })
}

function sync(node: object, next: Readonly<Record<string, unknown>>): void {
  const state = states.get(node)!
  const previous = state.holder.current

  if (previous === next) {
    return
  }

  state.holder.current = next

  for (const key of Object.keys(previous)) {
    if (Object.hasOwn(next, key) || isForbiddenKey(key)) {
      continue
    }

    const child = state.children.get(key)
    if (child !== undefined) {
      state.children.delete(key)
      sync(child, EMPTY)
    }
    delete (node as Record<string, unknown>)[key]
  }

  for (const key of Object.keys(next)) {
    if (isForbiddenKey(key)) {
      continue
    }

    const value = next[key]
    const child = state.children.get(key)

    if (isPlainObject(value)) {
      if (child === undefined) {
        // Absent before, or a leaf that became an object.
        define(node, state, key)
      } else {
        sync(child, value)
      }
    } else if (child !== undefined) {
      // An object that became a leaf. The old node is emptied, not left serving its last values.
      state.children.delete(key)
      sync(child, EMPTY)
      define(node, state, key)
    } else if (!Object.hasOwn(previous, key)) {
      define(node, state, key)
    }
    // A leaf that stays a leaf needs nothing: its accessor reads the holder.
  }
}
