import { ErrConfig } from './errors.js'
import { isForbiddenKey, isIndex, isPlainObject } from './tree.js'
import type { ConfigLayer, ConfigObject, ConfigValue } from './types.js'

/**
 * Merges layers into one tree. A later layer wins: plain objects merge key by key, and anything else replaces
 * what was there, so an array is replaced whole and an empty array clears a list. `undefined` is skipped.
 *
 * The result shares arrays and scalars with the layers and owns every object, so it can be frozen without
 * touching a layer.
 */
export function mergeLayers(layers: readonly ConfigLayer[]): ConfigObject {
  const merged: Record<string, unknown> = {}

  for (const layer of layers) {
    mergeInto(merged, layer.data)
  }

  return merged as ConfigObject
}

/**
 * Merges `values` into `target`, which it changes: plain objects merge key by key, and anything else replaces what
 * was there. `undefined` is skipped, and so are `__proto__`, `constructor` and `prototype`.
 *
 * A plain object of `values` is copied, never adopted, so `values` is never changed. Arrays and scalars are shared.
 */
export function mergeInto(
  target: Record<string, unknown>,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  for (const key of Object.keys(values)) {
    const next = values[key]

    if (next === undefined || isForbiddenKey(key)) {
      continue
    }

    if (isPlainObject(next)) {
      const previous = target[key]
      // `previous` belongs to `target`, the one thing a merge changes.
      target[key] = mergeInto(isPlainObject(previous) ? previous : {}, next)
    } else {
      target[key] = next
    }
  }

  return target
}

/**
 * Builds a tree from paths that are already split. A node whose keys are the indices 0 to n - 1 becomes an array.
 * Any other keys stay the keys of an object, numbers included, so `messages.404` is a record's key.
 *
 * A later entry for the same path wins. A path containing `__proto__`, `constructor` or `prototype` is skipped.
 *
 * @param source - Names the input in an error.
 * @param onConflict - Called, instead of throwing, with the path of a value that is dropped because the same path
 *   is also a parent. The parent wins, whichever came first.
 * @throws ErrConfig `ERR_CONFIG_KEY_CONFLICT` when a path is set both as a value and as a parent, unless
 *   `onConflict` is given.
 */
export function buildTree(
  entries: Iterable<readonly [parts: readonly string[], value: ConfigValue]>,
  source?: string,
  onConflict?: (path: readonly string[]) => void,
): ConfigObject {
  const root = branch()

  for (const [parts, value] of entries) {
    insert(root, parts, value, source, onConflict)
  }

  const tree: Record<string, ConfigValue> = {}
  for (const [key, child] of root.children) {
    tree[key] = toValue(child)
  }

  return tree
}

/**
 * Expands an object whose keys are dotted paths, at any depth: `{ 'db.host': 'x' }` becomes
 * `{ db: { host: 'x' } }`, and `servers[0].host` addresses an array element. Arrays and scalars are taken whole.
 * Keys that are the indices 0 to n - 1 make an array; any other numbers, such as status codes, are keys.
 *
 * For a format with no nesting of its own, handed to a file source's parser:
 * `new FileConfigSource('./app.ini', text => expandKeys(ini.parse(text)))`.
 *
 * @throws ErrConfig `ERR_CONFIG_KEY_CONFLICT` when a path is set both as a value and as a parent.
 */
export function expandKeys(flat: Readonly<Record<string, ConfigValue>>, source?: string): ConfigObject {
  const entries: [string[], ConfigValue][] = []
  collect(flat, [], entries)
  return buildTree(entries, source)
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

function collect(value: Readonly<Record<string, unknown>>, prefix: readonly string[], out: [string[], ConfigValue][]) {
  for (const key of Object.keys(value)) {
    const child = value[key]
    const parts = [...prefix, ...splitKey(key)]

    if (isPlainObject(child)) {
      collect(child, parts, out)
    } else if (child !== undefined) {
      out.push([parts, child as ConfigValue])
    }
  }
}

interface Branch {
  readonly kind: 'branch'
  readonly children: Map<string, Branch | Leaf>
}

interface Leaf {
  readonly kind: 'leaf'
  readonly value: ConfigValue
}

function branch(): Branch {
  return { kind: 'branch', children: new Map() }
}

function insert(
  root: Branch,
  parts: readonly string[],
  value: ConfigValue,
  source: string | undefined,
  onConflict: ((path: readonly string[]) => void) | undefined,
): void {
  if (parts.length === 0 || parts.some(isForbiddenKey)) {
    return
  }

  let node = root

  for (let i = 0; i < parts.length - 1; i++) {
    const child = node.children.get(parts[i])

    if (child?.kind === 'branch') {
      node = child
      continue
    }
    if (child?.kind === 'leaf') {
      // The value already there gives way to the parent.
      conflict(parts.slice(0, i + 1), source, onConflict)
    }

    const created = branch()
    node.children.set(parts[i], created)
    node = created
  }

  const last = parts[parts.length - 1]

  if (node.children.get(last)?.kind === 'branch') {
    conflict(parts, source, onConflict)
    return
  }

  node.children.set(last, { kind: 'leaf', value })
}

function conflict(
  path: readonly string[],
  source: string | undefined,
  onConflict: ((path: readonly string[]) => void) | undefined,
): void {
  if (onConflict === undefined) {
    throw errKeyConflict(path, source)
  }
  onConflict(path)
}

function toValue(node: Branch | Leaf): ConfigValue {
  if (node.kind === 'leaf') {
    return node.value
  }

  const keys = [...node.children.keys()]

  // Indices are distinct and canonical, so n of them all below n are exactly 0 to n - 1.
  if (keys.length > 0 && keys.every(key => isIndex(key) && Number(key) < keys.length)) {
    return Array.from({ length: keys.length }, (_, i) => toValue(node.children.get(String(i))!))
  }

  const tree: Record<string, ConfigValue> = {}
  for (const key of keys) {
    tree[key] = toValue(node.children.get(key)!)
  }
  return tree
}

function from(source: string | undefined): string {
  return source === undefined ? '' : ` from "${source}"`
}

function errKeyConflict(parts: readonly string[], source: string | undefined): ErrConfig {
  return new ErrConfig(
    `Cannot build config${from(source)}: "${parts.join('.')}" is set both as a value and as a parent`,
    'ERR_CONFIG_KEY_CONFLICT',
    undefined,
    'Set the whole value in one place, or only its children',
  )
}
