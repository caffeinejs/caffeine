import { errMessage } from '@caffeinejs/std/err'

import { ErrDevToolsConfiguration } from '../errors.js'

/** What a redacted value is shown as. */
export const REDACTED = '******'

/**
 * A key segment that names a secret wherever it sits in a path: `db.password`, `stripe.apiKey`,
 * `oauth.credentials.id`. Matched loosely on purpose: a value shown masked by mistake costs a look in the source, and
 * one shown in the clear by mistake is a leak.
 */
const SENSITIVE_SEGMENT = /pass(word|wd|phrase)?|pwd|secret|token|credential|key|signature|salt|cookie|auth|private/i

/**
 * Decides which configuration values are masked: a `$t.Secret` field, a path whose segments name a secret, a path an
 * application named with `redact(...)`; and, in any value shown, the password of a URL.
 */
export class Redactor {
  readonly #patterns: readonly RegExp[]

  /**
   * @param secret - The paths the schema marks with `$t.Secret`, `*` standing for an array item or a record entry.
   * @param patterns - Dotted paths, where `*` stands for one segment and `**` for any number of them.
   */
  constructor(secret: readonly string[], patterns: readonly string[]) {
    this.#patterns = [...secret.map(path => compile(path)), ...patterns.map(assertPattern).map(path => compile(path))]
  }

  /** Whether the value at `path`, or anything under it, is masked whole. */
  isSecret(path: string): boolean {
    return path.split('.').some(segment => SENSITIVE_SEGMENT.test(segment)) || this.#patterns.some(p => p.test(path))
  }

  /** The value at `path` as it may be shown: every secret in it masked, however deep. */
  redact(path: string, value: unknown): unknown {
    if (this.isSecret(path)) {
      return REDACTED
    }

    if (typeof value === 'string') {
      return maskCredentials(value)
    }

    if (Array.isArray(value)) {
      return value.map((item, at) => this.redact(`${path}.${at}`, item))
    }

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(`${path}.${key}`, item)]))
    }

    return value
  }
}

/**
 * `text` with the password of every URL in it masked: what an error naming a connection string is shown as.
 *
 * A password runs from the `:` after the user to the `@` before the host: the last `@` before a query or a fragment,
 * or the first one after when there is none before. It ends short of the next URL, unless it holds no `@` there, in
 * which case it runs on to the next space, so a raw `@`, `/`, `?`, `#` or `://` in a password is masked with it.
 * Masking too much is the safe failure. Read in one pass: a regular expression for it backtracks on a crafted value,
 * and a value comes from wherever the configuration was loaded.
 */
export function maskCredentials(text: string): string {
  let masked = ''
  let copied = 0
  let at = text.indexOf('://')

  while (at !== -1) {
    const next = text.indexOf('://', at + 3)
    // A scheme ends right before `://`.
    const colon = at > 0 && SCHEME_CHAR.test(text[at - 1]!) ? scan(text, at + 3, USER_END) : -1

    if (text[colon] !== ':') {
      at = next
      continue
    }

    const near = signOf(text, colon + 1, next === -1 ? text.length : next)
    // Past the next URL only when there is no `@` before it: up to the next space.
    const end = near === -1 ? scan(text, colon + 1, SPACE) : -1
    const sign = near === -1 ? signOf(text, colon + 1, end) : near

    if (sign !== -1) {
      masked += `${text.slice(copied, colon + 1)}${REDACTED}`
      copied = sign
    }

    // A URL a password holds is part of it; with no `@` up to the space, no URL before it has a password either.
    at = sign > next ? text.indexOf('://', sign) : near === -1 ? text.indexOf('://', Math.max(end, at + 3)) : next
  }

  return masked + text.slice(copied)
}

const SCHEME_CHAR = /[a-z0-9+.-]/i
/** What ends a URL's user: its password, its host, its path, or the end of the URL. */
const USER_END = /[:/?#@\s]/
const SPACE = /\s/

/** The index of the first character from `from` that `end` matches; the length of `text` when none does. */
function scan(text: string, from: number, end: RegExp): number {
  let at = from

  while (at < text.length && !end.test(text[at]!)) {
    at++
  }

  return at
}

/**
 * Where a password from `from` ends, short of `limit` and of a space: the last `@` before a `?` or a `#`, else the
 * first `@` after one; `-1` when there is no `@`.
 */
function signOf(text: string, from: number, limit: number): number {
  let before = -1
  let query = false

  for (let at = from; at < limit && !SPACE.test(text[at]!); at++) {
    const char = text[at]

    if (char === '@') {
      if (query) {
        return before === -1 ? at : before
      }
      before = at
    } else if (char === '?' || char === '#') {
      query = true
    }
  }

  return before
}

/** The dotted paths under `schema` a `$t.Secret` marks, `writeOnly` in JSON Schema. */
export function secretPaths(schema: unknown, at = ''): string[] {
  if (typeof schema !== 'object' || schema === null) {
    return []
  }

  const node = schema as SchemaNode

  if (node.writeOnly === true && at !== '') {
    return [at]
  }

  return [...childPaths(node, at), ...memberPaths(node, at)]
}

type SchemaNode = {
  writeOnly?: unknown
  properties?: unknown
  patternProperties?: unknown
  additionalProperties?: unknown
  items?: unknown
  anyOf?: unknown
  allOf?: unknown
}

/** The secret paths under a node's properties, items and entries. */
function childPaths(node: SchemaNode, at: string): string[] {
  const under = (segment: string): string => (at === '' ? segment : `${at}.${segment}`)
  const found: string[] = []

  for (const [key, child] of Object.entries(objectOf(node.properties))) {
    found.push(...secretPaths(child, under(key)))
  }

  // A tuple's member sits under its index; an array item and a record entry one segment down, under any name.
  if (Array.isArray(node.items)) {
    node.items.forEach((member, index) => found.push(...secretPaths(member, under(String(index)))))
  } else {
    found.push(...secretPaths(node.items, under('*')))
  }

  for (const child of [node.additionalProperties, ...Object.values(objectOf(node.patternProperties))]) {
    found.push(...secretPaths(child, under('*')))
  }

  return found
}

/** The secret paths a node's `anyOf` and `allOf` members mark at its own path. */
function memberPaths(node: SchemaNode, at: string): string[] {
  return [node.anyOf, node.allOf].flatMap(members =>
    Array.isArray(members) ? members.flatMap(member => secretPaths(member, at)) : [],
  )
}

function objectOf(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}

function assertPattern(pattern: string): string {
  if (!/^(\*\*|\*|[^.*]+)(\.(\*\*|\*|[^.*]+))*$/.test(pattern)) {
    throw new ErrDevToolsConfiguration(
      errMessage(`Cannot redact "${pattern}": it is not a dotted configuration path`)
        .solutions(
          'Write the path the way the configuration nests it, such as "stripe.webhookSecret"',
          'Use "*" for one segment and "**" for any number of them, such as "stripe.*"',
        )
        .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
        .build(),
    )
  }

  return pattern
}

function compile(pattern: string): RegExp {
  const body = pattern
    .split('.')
    .map(segmentPattern)
    .join(String.raw`\.`)

  // A path names its subtree too: `db` masks `db.url`.
  return new RegExp(String.raw`^${body}(\..+)?$`)
}

/** A segment of a redact pattern as a regular expression: `**` any segments, `*` one, anything else as written. */
function segmentPattern(segment: string): string {
  if (segment === '**') {
    return '.+'
  }

  return segment === '*' ? '[^.]+' : escape(segment)
}

function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
}
