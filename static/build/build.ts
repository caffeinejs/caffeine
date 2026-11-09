import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { Duration } from '@caffeinejs/std/duration'

import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  type Encoding,
  type ManifestFile,
  type ManifestVariant,
  type StaticManifest,
  variantPath,
} from '../manifest/manifest.js'
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

/**
 * Writes `br` and `gzip` variants beside each compressible file under `root`, and `static.manifest.json` at its root,
 * which a `staticFiles(...)` mount serves from.
 *
 * Run it at the end of the front-end build. A file is compressed when its type is compressible and it holds at
 * least 1 KiB, and a variant is kept when it is at most 95% of the file's size. Dotfiles but `.well-known/`,
 * symlinks and the variants of an earlier build are left out, and the variants of a file deleted since are removed.
 * Two builds of one tree write the same bytes. Files are read and compressed as streams, so a file's size is not
 * bounded by memory. Every file and the manifest are written under a hidden temporary name and renamed, so a failed
 * build leaves no half-written one, and nothing the next build reads.
 *
 * @throws {@link ErrStaticBuild} for a file nothing types, a name the router would read as syntax, or a root that
 * cannot be read
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
  const entries: Record<string, ManifestFile> = {}
  const saved: Record<Encoding, number> = { br: 0, gzip: 0 }
  let variants = 0
  let bytes = 0

  // One file at a time, so the build holds one file's chunks at once.
  for (const file of files) {
    const entry = await readFileEntry(root, file.path, file.type)
    const written: Partial<Record<Encoding, ManifestVariant>> = {}

    if (file.compressible && entry.size >= SMALLEST_COMPRESSED) {
      for (const encoding of ENCODINGS) {
        const path = variantPath(file.path, encoding)
        const variant = await writeAtomically(
          join(root, path),
          temporary => compressFile(join(root, file.path), temporary, encoding, entry.size),
          ({ size }) => size <= entry.size * KEPT_RATIO,
        )

        if (variant !== undefined) {
          written[encoding] = { ...variant, path }
          saved[encoding] += entry.size - variant.size
          variants++
        }
      }
    }

    entries[file.path] = { ...entry, variants: written }
    bytes += entry.size
  }

  const manifest: StaticManifest = { files: entries, version: MANIFEST_VERSION }
  await writeAtomically(join(root, MANIFEST_FILE), temporary =>
    writeFile(temporary, `${JSON.stringify(sorted(manifest), null, 2)}\n`, { flag: 'wx' }),
  )

  // The variants of a file deleted since the last build: the scan skipped them, and nothing lists them now.
  const listed = new Set(Object.values(entries).flatMap(entry => Object.values(entry.variants).map(v => v.path)))

  for (const { path, reason } of skipped) {
    if (reason === 'variant' && !listed.has(path)) {
      await rm(join(root, path), { force: true })
    }
  }

  return { files: files.length, variants, bytes, saved, skipped, duration: performance.now() - started }
}

/**
 * Has `write` write a new hidden file beside `path`, then renames it into place when `keep` takes what it wrote, and
 * removes it otherwise, or when anything throws. Hidden, so a temporary a killed build leaves is a dotfile the next
 * scan skips.
 */
async function writeAtomically<T>(
  path: string,
  write: (temporary: string) => Promise<T>,
  keep: (written: T) => boolean = () => true,
): Promise<T | undefined> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    const written = await write(temporary)

    if (keep(written)) {
      await rename(temporary, path)
      return written
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
