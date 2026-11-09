import { createHash } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { appendFile, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'

import { Second } from '@caffeinejs/std/duration'

import { contentTypeOf } from '../content_type.js'
import {
  MANIFEST_FILE,
  nameProblem,
  readManifest,
  type ManifestFile,
  type ManifestVariant,
} from '../manifest/manifest.js'
import { ErrStaticBuild } from './errors.js'

/** What the scan reads besides the fixed rules. */
export interface ScanOptions {
  /** Globs on root-relative paths, matched after the fixed rules. */
  readonly exclude?: readonly string[]
  /** Extension (`'.xyz'`) or root-relative path to content type, over the built-in table. */
  readonly types?: Readonly<Record<string, string>>
}

/**
 * Why the scan left a file out. A `variant` holds bytes an earlier build recorded writing, and the build may replace or
 * delete it; a `reserved` file sits where a variant of a file on disk goes, with bytes no build recorded, and is
 * neither served nor touched.
 */
export type SkipReason = 'dotfile' | 'manifest' | 'variant' | 'reserved' | 'symlink' | 'not-a-file' | 'excluded'

/** A file the scan left out, and the rule that did. */
export interface SkippedFile {
  readonly path: string
  readonly reason: SkipReason
}

/** A file the scan keeps: its root-relative POSIX path and how it is typed. */
export interface ScannedFile {
  readonly path: string
  readonly type: string
  readonly compressible: boolean
}

/** What a scan found under a root, each list sorted by path. */
export interface ScanResult {
  readonly files: readonly ScannedFile[]
  readonly skipped: readonly SkippedFile[]
}

const VARIANT_SUFFIXES = ['.br', '.gz']

/**
 * Walks `root` and decides, file by file, what is served.
 *
 * Fixed rules first: a symlink or anything else that is not a regular file is skipped; a path with a segment starting
 * with `.` is skipped, but under a leading `.well-known/`; the manifest is skipped. `x.br` and `x.gz` are skipped as
 * an earlier build's variants while they hold bytes a build recorded writing there, in the manifest or before a
 * manifest listed them, as `reserved` when they hold other bytes and `x` is on disk, and are files of their own
 * otherwise. Then
 * the names: one
 * holding a character the router or a URL reads as syntax, a control character, or not in Unicode NFC fails the scan.
 * Then `exclude`. Then the type: a file nothing types fails the scan. Every file a rule drops is in `skipped`.
 *
 * @throws {@link ErrStaticBuild} naming the files a name or a type refuses, or a root that cannot be read
 */
export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { exclude = [], types = {} } = options
  let entries: Dirent[]

  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch {
    throw new ErrStaticBuild(root, 'the root does not exist or cannot be read', 'Build the front end before this step')
  }

  const listed = entries
    .filter(entry => !entry.isDirectory())
    .map(entry => ({ entry, path: relative(root, join(entry.parentPath, entry.name)).split(sep).join('/') }))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1))
  const regular = new Set(listed.filter(({ entry }) => entry.isFile()).map(({ path }) => path))
  const recorded = await recordedVariants(root)

  const files: ScannedFile[] = []
  const skipped: SkippedFile[] = []
  const misnamed: string[] = []
  const untyped: string[] = []

  for (const { entry, path } of listed) {
    const reason = fixedRule(entry, path) ?? (await siblingRule(root, path, regular, recorded))

    if (reason !== undefined) {
      skipped.push({ path, reason })
      continue
    }

    const problem = nameProblem(path)

    if (problem !== undefined) {
      misnamed.push(problem)
      continue
    }

    if (exclude.some(glob => posix.matchesGlob(path, glob))) {
      skipped.push({ path, reason: 'excluded' })
      continue
    }

    const type = contentTypeOf(path, types)

    if (type === undefined) {
      untyped.push(path)
      continue
    }

    files.push({ path, ...type })
  }

  if (misnamed.length > 0) {
    throw new ErrStaticBuild(root, listOf(misnamed), 'Rename the file: its name is both its path on disk and its URL')
  }

  if (untyped.length > 0) {
    throw untypedError(root, untyped)
  }

  return { files, skipped }
}

/**
 * Describes the file at `path` under `root` as a manifest entry with no variant: size, SHA-256, `lastModified`
 * floored to the second, and `type`. The file is read as a stream, so its size is not bounded by a buffer's.
 */
export async function readFileEntry(root: string, path: string, type: string): Promise<ManifestFile> {
  const absolute = join(root, path)
  const { mtimeMs } = await stat(absolute)
  const { hash, size } = await hashFile(absolute)

  return { hash, lastModified: isoSecond(mtimeMs), size, type, variants: {} }
}

/** Base64 SHA-256 and size of the file at `path`, read as a stream and opened without following a symlink. */
export async function hashFile(path: string): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0

  // Undefined where a platform has no `O_NOFOLLOW`, which `|` reads as 0.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)

  // The stream closes the handle when it ends or fails.
  for await (const chunk of handle.createReadStream()) {
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).byteLength
  }

  return { hash: hash.digest('base64'), size }
}

/**
 * Where a build records each variant before renaming it into place, until its manifest records them: a build stopped
 * in between leaves bytes no manifest lists, and they are still its own. A dotfile, so the scan never serves it.
 */
const RECORD_FILE = '.static.variants'

/** The bytes a variant holds: its hash and size. */
type Recorded = Pick<ManifestVariant, 'hash' | 'size'>

/** What builds recorded writing, by path: a path can hold any of them. */
export type RecordedVariants = ReadonlyMap<string, readonly Recorded[]>

/**
 * Every variant a build wrote at `root` and recorded, by path: those the manifest lists, and those a build stopped
 * before its manifest recorded. A path can hold either. Whatever cannot be read records nothing.
 */
export async function recordedVariants(root: string): Promise<RecordedVariants> {
  const recorded = new Map<string, Recorded[]>()
  const add = ({ path, hash, size }: ManifestVariant): void => {
    recorded.set(path, [...(recorded.get(path) ?? []), { hash, size }])
  }

  try {
    const { files } = await readManifest(root)
    Object.values(files).forEach(file => Object.values(file.variants).forEach(add))
  } catch {
    // No manifest, or one this version cannot read: it records nothing.
  }

  const lines = await readFile(join(root, RECORD_FILE), 'utf8').catch(() => '')

  for (const line of lines.split('\n')) {
    try {
      const { path, hash, size } = JSON.parse(line) as ManifestVariant

      if (typeof path === 'string' && typeof hash === 'string' && typeof size === 'number') {
        add({ path, hash, size })
      }
    } catch {
      // An empty line, or one a stopped build cut short.
    }
  }

  return recorded
}

/** Records that the build is about to put `variant` in place. */
export async function recordVariant(root: string, variant: ManifestVariant): Promise<void> {
  await appendFile(join(root, RECORD_FILE), `${JSON.stringify(variant)}\n`)
}

/** Drops the record once a manifest lists what the build wrote. */
export async function clearRecordedVariants(root: string): Promise<void> {
  await rm(join(root, RECORD_FILE), { force: true })
}

/** Whether `bytes` are what a build recorded writing at `path`. */
export function isRecorded(recorded: RecordedVariants, path: string, bytes: Recorded): boolean {
  return recorded.get(path)?.some(({ hash, size }) => hash === bytes.hash && size === bytes.size) ?? false
}

// `x.br` and `x.gz`: the build's own while they hold bytes a build recorded writing there, whether or not `x` is still
// there, and reserved for a variant of `x` otherwise.
async function siblingRule(
  root: string,
  path: string,
  regular: ReadonlySet<string>,
  recorded: RecordedVariants,
): Promise<SkipReason | undefined> {
  const suffix = VARIANT_SUFFIXES.find(s => path.endsWith(s))

  if (suffix === undefined) {
    return undefined
  }

  if (recorded.has(path) && isRecorded(recorded, path, await hashFile(join(root, path)))) {
    return 'variant'
  }

  return regular.has(path.slice(0, -suffix.length)) ? 'reserved' : undefined
}

function fixedRule(entry: Dirent, path: string): SkipReason | undefined {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }

  if (!entry.isFile()) {
    return 'not-a-file'
  }

  const segments = path.split('/')
  if (segments.some((segment, i) => segment.startsWith('.') && !(i === 0 && segment === '.well-known'))) {
    return 'dotfile'
  }

  if (path === MANIFEST_FILE) {
    return 'manifest'
  }

  return undefined
}

function untypedError(root: string, paths: readonly string[]): ErrStaticBuild {
  const byExtension = Map.groupBy(paths, path => posix.extname(path).toLowerCase())
  const details: string[] = []
  const keys: string[] = []

  for (const [ext, group] of byExtension) {
    if (ext === '') {
      for (const path of group) {
        details.push(`no content type for "${path}", which has no extension`)
        keys.push(`'${path}'`)
      }
    } else {
      const count = group.length === 1 ? '1 file' : `${group.length} files`
      details.push(`no content type for "${ext}" (${count}, such as "${group[0]}")`)
      keys.push(`'${ext}'`)
    }
  }

  return new ErrStaticBuild(
    root,
    listOf(details),
    `Add the type to types: { ${keys.map(key => `${key}: '...'`).join(', ')} }`,
    'Add the file to exclude',
  )
}

/** Up to five problems in one line, and how many more there are. */
function listOf(problems: readonly string[]): string {
  const shown = problems.slice(0, 5).join('; ')

  return problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown
}

function isoSecond(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / Second) * Second).toISOString().replace('.000Z', 'Z')
}
