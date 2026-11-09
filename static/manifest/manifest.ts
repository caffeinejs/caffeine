import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { errMessage } from '@caffeinejs/std/err'

/** A content coding a file has a variant in. The manifest keys variants by it. */
export type Encoding = 'br' | 'gzip'

/** The format version this package writes and reads. */
export const MANIFEST_VERSION = 1

/** The manifest's file name, at the root it describes. */
export const MANIFEST_FILE = 'static.manifest.json'

const ENCODINGS: readonly string[] = ['br', 'gzip'] satisfies readonly Encoding[]

/** Where the build writes `path`'s variant in `encoding`, and the one path a manifest may list it at. */
export function variantPath(path: string, encoding: Encoding): string {
  return `${path}${encoding === 'br' ? '.br' : '.gz'}`
}

/** A compressed copy of a file, written beside it by the build. */
export interface ManifestVariant {
  /** Base64 SHA-256 of the variant's own bytes. */
  readonly hash: string
  /** Root-relative POSIX path of the variant file. */
  readonly path: string
  readonly size: number
}

/** One servable file, keyed in {@link StaticManifest.files} by its root-relative POSIX path. */
export interface ManifestFile {
  /** Base64 SHA-256 of the file's bytes: its `ETag` and, as `sha256-<hash>`, its subresource integrity value. */
  readonly hash: string
  /** When the file last changed, as an ISO 8601 time to the second. */
  readonly lastModified: string
  readonly size: number
  /** The `Content-Type` the file is served under. */
  readonly type: string
  readonly variants: Readonly<Partial<Record<Encoding, ManifestVariant>>>
}

/** What `static.manifest.json` holds: every file the server may send, and nothing else. */
export interface StaticManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly files: Readonly<Record<string, ManifestFile>>
}

/**
 * ErrStaticManifest is thrown at start-up when a root's manifest cannot be served from: it is missing, unreadable,
 * of another version or shape, or a file it lists is missing, of another size, not a regular file, or outside the
 * root.
 *
 * It extends `Error` rather than an `@caffeinejs/http` class so the manifest module, which the build shares, loads
 * nothing of the server.
 */
export class ErrStaticManifest extends Error {
  readonly code = 'ERR_STATIC_MANIFEST'

  constructor(root: string, detail: string, ...solutions: string[]) {
    super(
      errMessage(`Cannot serve "${root}": ${detail}`)
        .solutions(...solutions)
        .reference('@caffeinejs/static', ErrStaticManifest)
        .build(),
    )
    this.name = 'ErrStaticManifest'
  }
}

/** What a site reading a manifest offers for one that is missing or stale. */
export const REBUILD_SOLUTIONS: readonly string[] = [
  'Run buildStatic({ root }) from @caffeinejs/static/build after the front-end build',
  "Use mode: 'scan' in development",
]

/**
 * Reads and checks `<root>/static.manifest.json`: its JSON, its `version` and the shape of every entry. It touches no
 * other file: whether the files it lists exist is the server's check.
 *
 * @throws {@link ErrStaticManifest} naming what is wrong, and the field when it is the shape
 */
export async function readManifest(root: string): Promise<StaticManifest> {
  let text: string

  try {
    text = await readFile(join(root, MANIFEST_FILE), 'utf8')
  } catch (err) {
    const detail =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${MANIFEST_FILE} is missing`
        : `${MANIFEST_FILE} cannot be read`
    throw new ErrStaticManifest(root, detail, ...REBUILD_SOLUTIONS)
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ErrStaticManifest(root, `${MANIFEST_FILE} is not valid JSON`, ...REBUILD_SOLUTIONS)
  }

  const shape = (detail: string) => new ErrStaticManifest(root, detail, ...REBUILD_SOLUTIONS)

  if (!isObject(parsed)) {
    throw shape(`${MANIFEST_FILE} does not hold an object`)
  }

  if (parsed.version !== MANIFEST_VERSION) {
    throw shape(
      typeof parsed.version === 'number'
        ? `${MANIFEST_FILE} is version ${parsed.version}, and this server reads version ${MANIFEST_VERSION}`
        : `"version" is not a number`,
    )
  }

  if (!isObject(parsed.files)) {
    throw shape(`"files" is not an object`)
  }

  for (const [path, file] of Object.entries(parsed.files)) {
    checkFile(path, file, shape)
  }

  return parsed as unknown as StaticManifest
}

function checkFile(path: string, file: unknown, shape: (detail: string) => ErrStaticManifest): void {
  const at = `files.${path}`

  if (!isRelativePath(path)) {
    throw shape(`"${at}" is not a relative path under the root`)
  }

  const problem = nameProblem(path)

  if (problem !== undefined) {
    throw shape(problem)
  }

  // The build never lists one; a manifest written by hand must not publish `.env` beside the bundle either.
  if (path.split('/').some((segment, i) => segment.startsWith('.') && !(i === 0 && segment === '.well-known'))) {
    throw shape(`"${at}" has a segment starting with ".", which is never served`)
  }

  if (!isObject(file)) {
    throw shape(`"${at}" is not an object`)
  }

  checkFields(at, file, shape)

  if (typeof file.type !== 'string' || file.type === '') {
    throw shape(`"${at}.type" is not a string`)
  }

  // Written as Content-Type on every response: a line break would fail each one, or split the header.
  if (CONTROL.test(file.type)) {
    throw shape(`"${at}.type" is not a header value`)
  }

  if (typeof file.lastModified !== 'string' || Number.isNaN(Date.parse(file.lastModified))) {
    throw shape(`"${at}.lastModified" is not an ISO 8601 time`)
  }

  if (!isObject(file.variants)) {
    throw shape(`"${at}.variants" is not an object`)
  }

  for (const [encoding, variant] of Object.entries(file.variants)) {
    const vat = `${at}.variants.${encoding}`

    if (!ENCODINGS.includes(encoding)) {
      throw shape(`"${vat}" is not an encoding this server reads`)
    }

    if (!isObject(variant)) {
      throw shape(`"${vat}" is not an object`)
    }

    checkFields(vat, variant, shape)

    // The build writes each variant beside its file: any other path would send bytes the file's rules never checked.
    const expected = variantPath(path, encoding as Encoding)

    if (variant.path !== expected) {
      throw shape(`"${vat}.path" is not "${expected}", the path the build writes it at`)
    }
  }
}

/** The fields a file and a variant both carry. */
function checkFields(at: string, value: Record<string, unknown>, shape: (detail: string) => ErrStaticManifest): void {
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw shape(`"${at}.size" is not a number`)
  }

  if (typeof value.hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.hash)) {
    throw shape(`"${at}.hash" is not a base64 SHA-256`)
  }
}

// A path the build could have written: POSIX segments under the root, none empty, `.` or `..`, and no character a
// header or a file system path would read differently.
function isRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !/[\\\0]/.test(path) &&
    path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Characters find-my-way reads as route syntax, or a URL path cannot carry: the file could never be reached as
// itself, or would be reached as a pattern.
const SYNTAX: ReadonlyArray<readonly [string, string]> = [
  [':', 'which the router reads as a parameter'],
  ['*', 'which the router reads as a wildcard'],
  ['?', 'which ends a URL path'],
  ['#', 'which ends a URL path'],
  ['\\', 'which a URL path does not carry'],
]

const CONTROL = /\p{Cc}/u

/**
 * Why `path` cannot be a served name, or `undefined`: a character the router or a URL reads as syntax, a control
 * character, or a name not in Unicode NFC, which a URL would spell another way. The build and the manifest reader
 * both apply it.
 */
export function nameProblem(path: string): string | undefined {
  for (const [char, why] of SYNTAX) {
    if (path.includes(char)) {
      return `"${printable(path)}" holds "${char}", ${why}`
    }
  }

  if (CONTROL.test(path)) {
    return `"${printable(path)}" holds a control character`
  }

  if (path.normalize('NFC') !== path) {
    return `"${path}" is not in Unicode NFC`
  }

  return undefined
}

// A control character printed as its escape, so the message stays on one line.
function printable(path: string): string {
  return path.replaceAll(/\p{Cc}/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
