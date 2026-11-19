import { errMessage } from '@caffeinejs/std/err'

/** A content coding a file has a variant in. The manifest keys variants by it. */
export type Encoding = 'br' | 'gzip'

/** The format version this package writes and reads. */
export const MANIFEST_VERSION = 1

/** The manifest's file name, at the root it describes. */
export const MANIFEST_FILE = 'static.manifest.json'

const ENCODINGS: readonly string[] = ['br', 'gzip'] satisfies readonly Encoding[]

/** The directory under a root where the build keeps every variant, named by the hashes of its file and its own. */
export const VARIANT_DIRECTORY = '.static-variants'

/**
 * Where the build keeps the variant in `encoding` of a file whose bytes hash to `file`, the variant's own hashing to
 * `variant` (both base64), and the one path a manifest may list it at. Named by its own hash, it is never written
 * over with other bytes; named by its file's, it is listed for no other file.
 */
export function variantPath(file: string, variant: string, encoding: Encoding): string {
  const name = (hash: string) => hash.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

  return `${VARIANT_DIRECTORY}/${name(file)}.${name(variant)}.${encoding === 'br' ? 'br' : 'gz'}`
}

/** A compressed copy of a file, which the build keeps under {@link VARIANT_DIRECTORY}. */
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

/** Refuses a stored representation whose SHA-256 differs from the release inventory. */
export function assertStoredHash(root: string, key: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ErrStaticManifest(
      root,
      `"${key}" changed after the build, its bytes no longer match the manifest's hash`,
      ...REBUILD_SOLUTIONS,
    )
  }
}

/** Parses v1 manifest text. An entry limit selects strict stored-release validation for portable sources. */
export function parseManifest(text: string, root: string, maxEntries?: number): StaticManifest {
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

  const strict = maxEntries !== undefined

  if (strict) {
    requireFields(parsed, ['version', 'files'], MANIFEST_FILE, shape)
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

  const paths = Object.keys(parsed.files)

  if (maxEntries !== undefined && paths.length > maxEntries) {
    throw shape(`"files" exceeds the limit of ${maxEntries} identities`)
  }

  for (const path of paths) {
    if (maxEntries !== undefined && path === MANIFEST_FILE) {
      throw shape(`"${path}" is reserved for the release manifest`)
    }

    checkFile(path, parsed.files[path], shape, strict)
  }

  return parsed as unknown as StaticManifest
}

function checkFile(path: string, file: unknown, shape: (detail: string) => ErrStaticManifest, strict: boolean): void {
  const at = `files.${path}`

  if (!isRelativePath(path)) {
    throw shape(`"${at}" is not a relative path under the root`)
  }

  const problem = nameProblem(path, strict)

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

  if (strict) {
    requireFields(file, ['size', 'hash', 'type', 'lastModified', 'variants'], at, shape)
  }

  checkFields(at, file, shape)

  if (typeof file.type !== 'string' || file.type === '') {
    throw shape(`"${at}.type" is not a string`)
  }

  // Written as Content-Type on every response: a line break would fail each one, or split the header.
  if (!validContentTypeHeader(file.type)) {
    throw shape(`"${at}.type" is not a header value`)
  }

  if (typeof file.lastModified !== 'string' || Number.isNaN(Date.parse(file.lastModified))) {
    throw shape(`"${at}.lastModified" is not an ISO 8601 time`)
  }

  if (strict && new Date(file.lastModified).toISOString().replace(/\.\d{3}Z$/, 'Z') !== file.lastModified) {
    throw shape(`"${at}.lastModified" must be a UTC timestamp to the second, as written by buildStatic`)
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

    if (strict) {
      requireFields(variant, ['size', 'hash', 'path'], vat, shape)
    }

    checkFields(vat, variant, shape)

    // Any other path would send bytes the file's rules never checked, or another file's variant as this one's.
    const expected = variantPath(file.hash as string, variant.hash as string, encoding as Encoding)

    if (variant.path !== expected) {
      throw shape(`"${vat}.path" is not "${expected}", the path the build writes it at`)
    }
  }
}

function requireFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  at: string,
  shape: (detail: string) => ErrStaticManifest,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw shape(`"${at}.${field}" is missing`)
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
export function isRelativePath(path: string): boolean {
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
export function nameProblem(path: string, requireUTF8 = false): string | undefined {
  if (requireUTF8 && !path.isWellFormed()) {
    return `${JSON.stringify(path)} contains ill-formed Unicode`
  }

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

/** Whether a content type is nonempty and can be sent as a header value. */
export function validContentTypeHeader(type: string): boolean {
  // Printable Latin-1, excluding C1 controls. The build and manifest reader accept the same values.
  return /^[\x20-\x7e\xa0-\xff]+$/.test(type)
}
