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

/** `scheme://user:password@host`: what a URL with credentials carries before the host. */
const URL_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*):[^@/?#\s]*@/i

/**
 * Decides which configuration values are masked: a `$t.Secret` field, a path whose segments name a secret, a path an
 * application named with `redact(...)`; and, in any value shown, the password of a URL.
 */
export class Redactor {
  readonly #secret: readonly string[]
  readonly #patterns: readonly RegExp[]

  /**
   * @param secret - The paths the schema marks with `$t.Secret`.
   * @param patterns - Dotted paths, where `*` stands for one segment and `**` for any number of them.
   */
  constructor(secret: readonly string[], patterns: readonly string[]) {
    this.#secret = secret
    this.#patterns = patterns.map(compile)
  }

  /** Whether the value at `path`, or anything under it, is masked whole. */
  isSecret(path: string): boolean {
    return (
      this.#secret.some(secret => path === secret || path.startsWith(`${secret}.`)) ||
      path.split('.').some(segment => SENSITIVE_SEGMENT.test(segment)) ||
      this.#patterns.some(pattern => pattern.test(path))
    )
  }

  /** The value at `path` as it may be shown. */
  redact(path: string, value: unknown): unknown {
    if (this.isSecret(path)) {
      return REDACTED
    }

    return maskURLs(value)
  }
}

/** The dotted paths under `schema` a `$t.Secret` marks, `writeOnly` in JSON Schema. */
export function secretPaths(schema: unknown, at = ''): string[] {
  if (typeof schema !== 'object' || schema === null) {
    return []
  }

  const node = schema as { writeOnly?: unknown; properties?: unknown; anyOf?: unknown; allOf?: unknown }

  if (node.writeOnly === true && at !== '') {
    return [at]
  }

  const found: string[] = []

  if (typeof node.properties === 'object' && node.properties !== null) {
    for (const [key, child] of Object.entries(node.properties)) {
      found.push(...secretPaths(child, at === '' ? key : `${at}.${key}`))
    }
  }

  for (const members of [node.anyOf, node.allOf]) {
    if (Array.isArray(members)) {
      for (const member of members) {
        found.push(...secretPaths(member, at))
      }
    }
  }

  return found
}

function maskURLs(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(URL_PASSWORD, `$1:${REDACTED}@`)
  }

  if (Array.isArray(value)) {
    return value.map(maskURLs)
  }

  return value
}

function compile(pattern: string): RegExp {
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

  const body = pattern
    .split('.')
    .map(segment => (segment === '**' ? '.+' : segment === '*' ? '[^.]+' : escape(segment)))
    .join('\\.')

  // A path names its subtree too: `db` masks `db.url`.
  return new RegExp(`^${body}(\\..+)?$`)
}

function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
