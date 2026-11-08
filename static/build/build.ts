import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Duration } from '@caffeinejs/std/duration'

import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  type Encoding,
  type ManifestFile,
  type ManifestVariant,
  type StaticManifest,
} from '../manifest/manifest.js'
import { readFileEntry, scan, sha256, type SkippedFile } from '../scan/scan.js'
import { KEPT_RATIO, SMALLEST_COMPRESSED, compress } from './_compress.js'

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
 * symlinks and the variants of an earlier build are left out. Two builds of one tree write the same bytes. Every
 * file and the manifest are written under a temporary name and renamed, so a failed build leaves no half-written
 * one.
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

  // One file at a time, so memory holds one file and its variants.
  for (const file of files) {
    const { bytes: identity, entry } = await readFileEntry(root, file.path, file.type)
    const written: Partial<Record<Encoding, ManifestVariant>> = {}

    if (file.compressible && identity.byteLength >= SMALLEST_COMPRESSED) {
      for (const encoding of ENCODINGS) {
        const variant = await compress(identity, encoding)

        if (variant.byteLength <= identity.byteLength * KEPT_RATIO) {
          const path = `${file.path}${encoding === 'br' ? '.br' : '.gz'}`
          await writeAtomically(join(root, path), variant)
          written[encoding] = { hash: sha256(variant), path, size: variant.byteLength }
          saved[encoding] += identity.byteLength - variant.byteLength
          variants++
        }
      }
    }

    entries[file.path] = { ...entry, variants: written }
    bytes += identity.byteLength
  }

  const manifest: StaticManifest = { files: entries, version: MANIFEST_VERSION }
  await writeAtomically(join(root, MANIFEST_FILE), `${JSON.stringify(sorted(manifest), null, 2)}\n`)

  return { files: files.length, variants, bytes, saved, skipped, duration: performance.now() - started }
}

/** Writes `data` under a temporary name beside `path`, then renames it into place. */
async function writeAtomically(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`

  await writeFile(temporary, data)
  await rename(temporary, path)
}

/** A copy of `value` whose object keys are in sorted order at every depth, so the JSON is the same every build. */
function sorted(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]),
  )
}
