import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { Duration } from '@caffeinejs/std/duration'

import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  type Encoding,
  type ManifestFile,
  type ManifestVariant,
  type StaticManifest,
  VARIANT_DIRECTORY,
  variantPath,
} from '../manifest/manifest.js'
import { ErrStaticBuild } from '../scan/errors.js'
import { readFileEntry, scan, type SkippedFile } from '../scan/scan.js'
import { KEPT_RATIO, SMALLEST_COMPRESSED, compressFile } from './_compress.js'

/** {@link buildStatic}'s options. */
export interface BuildOptions {
  /** The directory to read, written in place. A relative one is resolved against the working directory. */
  readonly root: string
  /** Globs on root-relative paths, matched after the fixed rules, such as `['assets/*.map']`. Default `[]`. */
  readonly exclude?: readonly string[]
  /**
   * Content types over the built-in table, keyed by extension (`'.xyz'`) or by root-relative path
   * (`'.well-known/apple-app-site-association'`), the path first. Default `{}`.
   */
  readonly types?: Readonly<Record<string, string>>
}

/** What {@link buildStatic} did. */
export interface BuildReport {
  /** Files in the manifest. */
  readonly files: number
  /** Variants written. */
  readonly variants: number
  /** Bytes of the files in the manifest, uncompressed. */
  readonly bytes: number
  /** Bytes each coding's variants save over the files they stand for. */
  readonly saved: Readonly<Record<Encoding, number>>
  /** Files a rule left out, each with the rule. */
  readonly skipped: readonly SkippedFile[]
  readonly duration: Duration
}

const ENCODINGS: readonly Encoding[] = ['br', 'gzip']

/** A variant the build keeps: named by its file's URL-safe base64 SHA-256, its own, and the coding's extension. */
const STORED = /^[\w-]{43}\.[\w-]{43}\.(?:br|gz)$/

/** A temporary a build writes before renaming it into place, or leaves behind when it is stopped. */
const TEMPORARY = /^\.[0-9a-f]{12}\.tmp$/

/**
 * Writes `br` and `gzip` variants of each compressible file under `root`, and `static.manifest.json` at its root,
 * which a `staticFiles(...)` mount serves from.
 *
 * Run it at the end of the front-end build. A file is compressed when its type is compressible and it holds at
 * least 1 KiB, and a variant is kept when it is at most 95% of the file's size. Dotfiles but `.well-known/`, and
 * symlinks, are left out. Two builds of one tree write the same bytes. Files are read and compressed as streams, so a
 * file's size is not bounded by memory.
 *
 * The variants live in `.static-variants/` under the root, which is the build's own: each is named by the hashes of
 * its file and of its own bytes, so no variant is ever written over with other bytes, and a site's own `x.gz` is a
 * file like any other. Every
 * variant and the manifest are written under a hidden temporary name and renamed into place, the manifest last. A
 * build stopped at any point leaves the previous manifest and every variant it lists as they were: the next build, of
 * any input, succeeds. Once the new manifest is in place, the build removes the variants it no longer lists, and the
 * temporaries a stopped build left. Run one build of a root at a time: each removes what the other is writing.
 *
 * @throws {@link ErrStaticBuild} for a file nothing types, a name the router would read as syntax, a
 * `.static-variants` that is not a directory, or a root that cannot be read
 * @example
 * ```ts
 * const report = await buildStatic({ root: 'web/dist', exclude: ['assets/*.map'] })
 * console.log(`${report.files} files, ${report.variants} variants`)
 * ```
 */
export async function buildStatic(options: BuildOptions): Promise<BuildReport> {
  const started = performance.now()
  const root = resolve(options.root)
  const { files, skipped } = await scan(root, options)
  const store = await variantDirectory(root)
  // Keyed by the site's paths, "__proto__" among them.
  const entries: Record<string, ManifestFile> = Object.create(null)
  const saved: Record<Encoding, number> = { br: 0, gzip: 0 }
  let variants = 0
  let bytes = 0

  // One file at a time, so the build holds one file's chunks at once.
  for (const file of files) {
    const entry = await readFileEntry(root, file.path, file.type)
    const written: Partial<Record<Encoding, ManifestVariant>> = {}

    if (file.compressible && entry.size >= SMALLEST_COMPRESSED) {
      for (const encoding of ENCODINGS) {
        const variant = await writeAtomically(
          store,
          temporary => compressFile(join(root, file.path), temporary, encoding, entry.size),
          compressed =>
            compressed.size > entry.size * KEPT_RATIO ? undefined : variantPath(entry.hash, compressed.hash, encoding),
        )

        if (variant !== undefined) {
          written[encoding] = { ...variant.written, path: variant.path }
          saved[encoding] += entry.size - variant.written.size
          variants++
        }
      }
    }

    entries[file.path] = { ...entry, variants: written }
    bytes += entry.size
  }

  const manifest: StaticManifest = { files: entries, version: MANIFEST_VERSION }
  await writeAtomically(
    store,
    temporary => writeFile(temporary, `${JSON.stringify(sorted(manifest), null, 2)}\n`, { flag: 'wx' }),
    () => MANIFEST_FILE,
  )

  // Only once the manifest no longer lists them. A build stopped here leaves them for the next one to remove.
  const listed = new Set(Object.values(entries).flatMap(entry => Object.values(entry.variants).map(v => v.path)))

  for (const entry of await readdir(store, { withFileTypes: true })) {
    const path = `${VARIANT_DIRECTORY}/${entry.name}`

    if (entry.isFile() && ((STORED.test(entry.name) && !listed.has(path)) || TEMPORARY.test(entry.name))) {
      await rm(join(root, path), { force: true })
    }
  }

  return { files: files.length, variants, bytes, saved, skipped, duration: performance.now() - started }
}

/** The build's own directory of variants under `root`, made when it is not there. */
async function variantDirectory(root: string): Promise<string> {
  const store = join(root, VARIANT_DIRECTORY)
  const stats = await lstat(store).catch(() => undefined)

  if (stats === undefined) {
    await mkdir(store)
  } else if (!stats.isDirectory()) {
    // A link would have the build write, and remove, wherever it points.
    throw new ErrStaticBuild(
      root,
      `"${VARIANT_DIRECTORY}" is not a directory, and the build keeps the variants there`,
      `Rename "${VARIANT_DIRECTORY}", or move it out of the root`,
    )
  }

  return store
}

/**
 * Has `write` write a new hidden file in `directory`, then renames it to the root-relative path `destination` names
 * for what it wrote, or removes it when `destination` names none, or when anything throws. Hidden, so a temporary a
 * stopped build leaves is a dotfile the next scan skips, and the next build removes.
 */
async function writeAtomically<T>(
  directory: string,
  write: (temporary: string) => Promise<T>,
  destination: (written: T) => string | undefined,
): Promise<{ written: T; path: string } | undefined> {
  const temporary = join(directory, `.${randomBytes(6).toString('hex')}.tmp`)

  try {
    const written = await write(temporary)
    const path = destination(written)

    if (path !== undefined) {
      await rename(temporary, join(dirname(directory), path))
      return { written, path }
    }
  } catch (err) {
    await rm(temporary, { force: true })
    throw err
  }

  await rm(temporary, { force: true })
  return undefined
}

/** A copy of `value` whose object keys are in sorted order at every depth, so the JSON is the same every build. */
function sorted(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      // By code unit, not by locale: two builds on two machines write the same bytes.
      .toSorted((a, b) => Number(a > b) - Number(a < b))
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]),
  )
}
