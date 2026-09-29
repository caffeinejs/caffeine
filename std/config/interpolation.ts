import type { SchemaIssue } from '../schema/schema.js'
import { ErrConfig, ErrConfigValidation } from './errors.js'
import { mergeLayers } from './merge.js'
import { PROFILES_KEY } from './profiles.js'
import { isIndex, isPlainObject, splitKey } from './tree.js'
import type { ConfigLayer, ConfigObject } from './types.js'

type Env = Readonly<Record<string, string | undefined>>

/** The longest text a value may reach through its placeholders. */
const MAX_LENGTH = 1_048_576

/** The most values one chain of references may pass through. Deeper, the recursion would outgrow the stack. */
const MAX_DEPTH = 32

const ENV_NAME = /^[A-Za-z_]\w*$/
const NOT_IN_PATH = /[\s${]/

interface Placeholder {
  readonly prefix: 'env' | 'config'
  readonly key: string
  /** The path a `config` key names, split. */
  readonly parts: readonly string[]
  readonly fallback: string | undefined
}

/** Why a string does not parse, and where the placeholder at fault starts. */
interface Malformed {
  readonly reason: string
  readonly at: number
}

/** A string of an interpolating layer that holds a placeholder. An object, so that the merge moves it whole. */
class Template {
  constructor(
    readonly text: string,
    readonly layer: string,
    readonly path: string,
  ) {}
}

/** Why a template has no value: the template at fault, the placeholder in it, if one is to blame, and the reason. */
interface Failure {
  readonly template: Template
  readonly placeholder: string | undefined
  readonly reason: string
  /** A chain that ran too deep, which says nothing of the values it went through: never remembered for them. */
  readonly deep?: true
}

/**
 * Merges the layers, then replaces each placeholder that survived the merge with what it names: an environment
 * variable, or a value of the merged configuration, itself interpolated first. Only a layer marked `interpolate` has
 * placeholders; a placeholder that lost the merge is never looked at, and what one brings in is never read again.
 *
 * @throws ErrConfigValidation with an `ERR_CONFIG_INTERPOLATION` issue at each value that cannot be interpolated.
 */
export function mergeInterpolated(layers: readonly ConfigLayer[], env: Env = process.env): ConfigObject {
  const marked = layers.map(layer => (layer.interpolate === true ? mark(layer) : layer))
  const merged = mergeLayers(marked)

  if (marked.every((layer, i) => layer === layers[i])) {
    return merged
  }

  const interpolation = new Interpolation(merged, env)
  const out = mapLeaves(merged, [], (value, parts) =>
    value instanceof Template ? interpolation.fill(value, parts) : value,
  )

  if (interpolation.issues.length > 0) {
    throw new ErrConfigValidation(interpolation.issues)
  }

  return out as ConfigObject
}

/**
 * Checks the syntax of every placeholder in a file as it is read, overridden or not, so that a malformed one fails
 * the load that brought it. The error names the file, the path and the character, never the text.
 *
 * @throws ErrConfig `ERR_CONFIG_INTERPOLATION` when a placeholder is malformed, or when `caffeine.profiles` holds `${`.
 */
export function checkInterpolation(data: Readonly<Record<string, unknown>>, file: string): void {
  mapLeaves(data, [], (value, parts) => {
    if (typeof value !== 'string' || !value.includes('${')) {
      return value
    }

    if (parts[0] === PROFILES_KEY[0] && parts[1] === PROFILES_KEY[1]) {
      throw errInterpolation(
        file,
        parts,
        'the active profiles are chosen before anything is interpolated',
        'Name the profiles with CAFFEINE__PROFILES or --caffeine.profiles',
      )
    }

    const segments = parseTemplate(value)
    if (!Array.isArray(segments)) {
      throw errInterpolation(
        file,
        parts,
        `the placeholder at character ${segments.at + 1} ${segments.reason}`,
        'Write "$${" for a "${" that is not a placeholder',
        'Set interpolate: false on the source to read the file as written',
      )
    }

    return value
  })
}

class Interpolation {
  readonly issues: SchemaIssue[] = []
  readonly #tree: ConfigObject
  readonly #env: Env
  readonly #done = new Map<Template, string | Failure>()
  readonly #resolving: Template[] = []

  constructor(tree: ConfigObject, env: Env) {
    this.#tree = tree
    this.#env = env
  }

  /** The text of the template at `parts`, or the template itself once its issue is recorded. */
  fill(template: Template, parts: readonly string[]): unknown {
    const value = this.#valueOf(template)
    if (typeof value === 'string') {
      return value
    }

    const path = parts.join('.')
    this.issues.push({ path, message: describe(value, path), code: 'ERR_CONFIG_INTERPOLATION' })
    return template
  }

  #valueOf(template: Template): string | Failure {
    const done = this.#done.get(template)
    if (done !== undefined) {
      return done
    }

    const start = this.#resolving.indexOf(template)
    if (start !== -1) {
      const loop = [...this.#resolving.slice(start), template].map(t => t.path).join(' -> ')
      return { template, placeholder: undefined, reason: `its references loop: ${loop}` }
    }

    // The chain fails where it started. A value it went through may be shallow enough when it is filled in on its
    // own, so none of them remembers this failure.
    if (this.#resolving.length === MAX_DEPTH) {
      const reason = `its references run more than ${MAX_DEPTH} deep`
      return { template: this.#resolving[0], placeholder: undefined, reason, deep: true }
    }

    this.#resolving.push(template)
    const value = this.#interpolate(template)
    this.#resolving.pop()

    if (typeof value === 'string' || value.deep !== true) {
      this.#done.set(template, value)
    }
    return value
  }

  #interpolate(template: Template): string | Failure {
    const segments = parseTemplate(template.text)
    if (!Array.isArray(segments)) {
      const reason = `the placeholder at character ${segments.at + 1} ${segments.reason}`
      return { template, placeholder: undefined, reason }
    }

    let text = ''
    for (const segment of segments) {
      if (typeof segment === 'string') {
        text += segment
      } else {
        const value = this.#resolve(segment, template)
        if (typeof value !== 'string') {
          return value
        }
        text += value
      }

      if (text.length > MAX_LENGTH) {
        return { template, placeholder: undefined, reason: `it is longer than ${MAX_LENGTH} characters` }
      }
    }

    return text
  }

  #resolve(placeholder: Placeholder, template: Template): string | Failure {
    const fail = (reason: string): Failure => ({
      template,
      placeholder: `\${${placeholder.prefix}:${placeholder.key}}`,
      reason,
    })

    if (placeholder.prefix === 'env') {
      const value = Object.hasOwn(this.#env, placeholder.key) ? this.#env[placeholder.key] : undefined
      if (value === undefined) {
        return placeholder.fallback ?? fail('the environment variable is not set')
      }
      return value === '' ? (placeholder.fallback ?? '') : value
    }

    let value = lookup(this.#tree, placeholder.parts)
    if (value instanceof Template) {
      value = this.#valueOf(value)
      if (typeof value !== 'string') {
        return value as Failure
      }
    }

    if (value === undefined || value === null) {
      return placeholder.fallback ?? fail(`"${placeholder.key}" is not set`)
    }
    if (value === '') {
      return placeholder.fallback ?? ''
    }
    if (typeof value === 'string') {
      return value
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }

    return fail(`"${placeholder.key}" is ${Array.isArray(value) ? 'a list' : 'an object'}, not a single value`)
  }
}

/**
 * Splits a string into literal text and placeholders, or says why it cannot. One pass: every character is looked at
 * a bounded number of times, whatever the text.
 */
function parseTemplate(text: string): (string | Placeholder)[] | Malformed {
  const segments: (string | Placeholder)[] = []
  let literal = ''
  let i = 0

  while (i < text.length) {
    const dollar = text.indexOf('$', i)
    if (dollar === -1) {
      literal += text.slice(i)
      break
    }
    literal += text.slice(i, dollar)
    const end = skipDollars(text, dollar)

    // Only a run of `$` right before `{` is special: each `$$` is one `$`, and an odd one out opens a placeholder.
    if (text[end] !== '{') {
      literal += text.slice(dollar, end)
      i = end
      continue
    }

    const run = end - dollar
    literal += '$'.repeat(Math.floor(run / 2))
    if (run % 2 === 0) {
      literal += '{'
      i = end + 1
      continue
    }

    const at = end - 1
    const close = text.indexOf('}', end + 1)
    if (close === -1) {
      return { reason: 'is not closed', at }
    }

    const placeholder = parsePlaceholder(text.slice(end + 1, close))
    if (typeof placeholder === 'string') {
      return { reason: placeholder, at }
    }

    if (literal !== '') {
      segments.push(literal)
      literal = ''
    }
    segments.push(placeholder)
    i = close + 1
  }

  if (literal !== '') {
    segments.push(literal)
  }

  return segments
}

/** The index just past the run of `$` that starts at `from`. */
function skipDollars(text: string, from: number): number {
  let end = from
  while (text[end] === '$') {
    end++
  }
  return end
}

/** The placeholder `body` describes, or why it describes none. `body` is what lies between `${` and `}`. */
function parsePlaceholder(body: string): Placeholder | string {
  const colon = body.indexOf(':')
  if (colon === -1) {
    return 'needs a prefix and a key, as in "${env:NAME}"'
  }

  const prefix = body.slice(0, colon)
  if (prefix !== 'env' && prefix !== 'config') {
    return 'has a prefix other than "env" or "config"'
  }

  const rest = body.slice(colon + 1)
  const separator = rest.indexOf(':')
  const key = separator === -1 ? rest : rest.slice(0, separator)
  let fallback: string | undefined

  if (separator !== -1) {
    if (rest[separator + 1] !== '-') {
      return 'has something other than ":-" and a default after its key'
    }
    fallback = rest.slice(separator + 2)
    if (fallback.includes('${')) {
      return 'has a default that contains "${"'
    }
  }

  if (key === '') {
    return 'has no key'
  }

  if (prefix === 'env') {
    return ENV_NAME.test(key)
      ? { prefix, key, parts: [], fallback }
      : 'names an environment variable with a character other than a letter, a digit or "_", or with a leading digit'
  }

  const parts = splitKey(key)
  if (NOT_IN_PATH.test(key) || parts.includes('')) {
    return 'has a config path with an empty key, a space, "$" or "{"'
  }

  return { prefix, key, parts, fallback }
}

/** Marks each string of `layer` that holds `${`. The layer comes back as it is when it holds none. */
function mark(layer: ConfigLayer): ConfigLayer {
  const data = mapLeaves(layer.data, [], (value, parts) =>
    typeof value === 'string' && value.includes('${') ? new Template(value, layer.name, parts.join('.')) : value,
  )

  return data === layer.data ? layer : { ...layer, data: data as ConfigObject }
}

/** The value at `parts`. Only plain objects and arrays are entered: a template is a value, never a way through. */
function lookup(tree: unknown, parts: readonly string[]): unknown {
  let node = tree

  for (const part of parts) {
    if (Array.isArray(node)) {
      node = isIndex(part) ? node[Number(part)] : undefined
    } else if (isPlainObject(node)) {
      node = Object.hasOwn(node, part) ? node[part] : undefined
    } else {
      return undefined
    }
  }

  return node
}

/**
 * `value` with each leaf replaced by what `leaf` returns. A container none of whose leaves changed comes back as it
 * is, and one whose leaves did comes back as a copy: nothing is mutated.
 */
function mapLeaves(
  value: unknown,
  parts: readonly string[],
  leaf: (value: unknown, parts: readonly string[]) => unknown,
): unknown {
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const next = mapLeaves(value[i], [...parts, String(i)], leaf)
      if (next !== value[i]) {
        copy ??= [...value]
        copy[i] = next
      }
    }
    return copy ?? value
  }

  if (isPlainObject(value)) {
    let copy: Record<string, unknown> | undefined
    for (const key of Object.keys(value)) {
      const next = mapLeaves(value[key], [...parts, key], leaf)
      if (next !== value[key]) {
        copy ??= { ...value }
        copy[key] = next
      }
    }
    return copy ?? value
  }

  return leaf(value, parts)
}

/** An issue's message: the placeholder, where the template at fault sits when that is not the issue's own path, why. */
function describe(failure: Failure, path: string): string {
  const { template, placeholder, reason } = failure
  const what = placeholder === undefined ? 'the value' : `"${placeholder}"`
  const where = template.path === path ? '' : ` at "${template.path}"`

  return `cannot interpolate ${what}${where} from "${template.layer}": ${reason}`
}

function errInterpolation(file: string, parts: readonly string[], reason: string, ...solutions: string[]): ErrConfig {
  return new ErrConfig(
    `Cannot interpolate "${parts.join('.')}" in config file "${file}": ${reason}`,
    'ERR_CONFIG_INTERPOLATION',
    undefined,
    ...solutions,
  )
}
