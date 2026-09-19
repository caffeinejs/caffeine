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

function mergeInto(target: Record<string, unknown>, layer: ConfigObject): Record<string, unknown> {
  for (const key of Object.keys(layer)) {
    const next = layer[key]

    if (next === undefined || isForbiddenKey(key)) {
      continue
    }

    if (isPlainObject(next)) {
      const previous = target[key]
      // `previous` is plain only when this merge created it, so filling it in never touches a layer.
      target[key] = mergeInto(isPlainObject(previous) ? previous : {}, next as ConfigObject)
    } else {
      target[key] = next
    }
  }

  return target
}

/**
 * Builds a tree from paths that are already split. A node whose children are all array indices becomes an
 * array, and the indices must be a complete list from 0.
 *
 * A later entry for the same path wins. A path containing `__proto__`, `constructor` or `prototype` is skipped.
 *
 * @param source - Names the input in an error.
 * @throws ErrConfig `ERR_CONFIG_ARRAY_INDICES` when an array's indices have a gap or do not start at 0.
 * @throws ErrConfig `ERR_CONFIG_KEY_CONFLICT` when a path is set both as a value and as a parent.
 */
export function buildTree(
  entries: Iterable<readonly [parts: readonly string[], value: ConfigValue]>,
  source?: string,
): ConfigObject {
  const root = branch()

  for (const [parts, value] of entries) {
    insert(root, parts, value, source)
  }

  const tree: Record<string, ConfigValue> = {}
  for (const [key, child] of root.children) {
    tree[key] = toValue(child, [key], source)
  }

  return tree
}

/**
 * Expands an object whose keys are dotted paths, at any depth: `{ 'db.host': 'x' }` becomes
 * `{ db: { host: 'x' } }`, and `servers[0].host` addresses an array element. Arrays and scalars are taken whole.
 *
 * For a format with no nesting of its own, handed to a file source's parser:
 * `new FileConfigSource('./app.ini', text => expandKeys(ini.parse(text)))`.
 *
 * @throws ErrConfig `ERR_CONFIG_ARRAY_INDICES`, `ERR_CONFIG_KEY_CONFLICT`, as {@link buildTree}.
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

function insert(root: Branch, parts: readonly string[], value: ConfigValue, source: string | undefined): void {
  if (parts.length === 0 || parts.some(isForbiddenKey)) {
    return
  }

  let node = root

  for (let i = 0; i < parts.length - 1; i++) {
    const child = node.children.get(parts[i])

    if (child === undefined) {
      const created = branch()
      node.children.set(parts[i], created)
      node = created
    } else if (child.kind === 'leaf') {
      throw errKeyConflict(parts.slice(0, i + 1), source)
    } else {
      node = child
    }
  }

  const last = parts[parts.length - 1]

  if (node.children.get(last)?.kind === 'branch') {
    throw errKeyConflict(parts, source)
  }

  node.children.set(last, { kind: 'leaf', value })
}

function toValue(node: Branch | Leaf, path: readonly string[], source: string | undefined): ConfigValue {
  if (node.kind === 'leaf') {
    return node.value
  }

  const keys = [...node.children.keys()]

  if (keys.length > 0 && keys.every(isIndex)) {
    const indices = keys.map(Number).sort((a, b) => a - b)

    if (indices[indices.length - 1] !== indices.length - 1) {
      throw errArrayIndices(path, indices, source)
    }

    return indices.map(index => toValue(node.children.get(String(index))!, [...path, String(index)], source))
  }

  const tree: Record<string, ConfigValue> = {}
  for (const key of keys) {
    tree[key] = toValue(node.children.get(key)!, [...path, key], source)
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

function errArrayIndices(path: readonly string[], indices: readonly number[], source: string | undefined): ErrConfig {
  const prefix = path.join('.')

  return new ErrConfig(
    `Cannot build config array "${prefix}"${from(source)}: indices [${indices.join(', ')}] are not a complete list`,
    'ERR_CONFIG_ARRAY_INDICES',
    undefined,
    'Set the whole array rather than one element: a later-registered source replaces a list, it does not patch it',
    `Start the indices at 0 and leave no gaps, e.g. "${prefix}.0", "${prefix}.1"`,
  )
}
