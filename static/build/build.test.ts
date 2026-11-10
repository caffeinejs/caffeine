import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MANIFEST_FILE,
  VARIANT_DIRECTORY,
  readManifest,
  type ManifestFile,
  type StaticManifest,
  variantPath,
} from '../manifest/manifest.js'
import { ErrStaticBuild } from '../scan/errors.js'
import { buildStatic } from './build.js'

const SPA = fileURLToPath(new URL('../_tests/_testdata/spa', import.meta.url))

/** `length` bytes no coder shrinks, the same every run. */
function noise(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  let state = 0x2545f491

  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[i] = state & 0xff
  }

  return bytes
}

describe('buildStatic', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caffeine-build-'))
    await cp(SPA, root, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes both variants into its own directory, named by their hash, and lists them in the manifest', async () => {
    const report = await buildStatic({ root })
    const { files } = await readManifest(root)
    const script = files['assets/app-eZr2sdaR.js']!

    expect(Object.keys(files)).toEqual([
      'assets/app-eZr2sdaR.js',
      'assets/style-A1b2C3d4.css',
      'favicon.svg',
      'index.html',
    ])
    expect(script.variants.br!.path).toBe(variantPath(script.hash, script.variants.br!.hash, 'br'))
    expect(script.variants.gzip!.path).toBe(variantPath(script.hash, script.variants.gzip!.hash, 'gzip'))

    const original = await readFile(join(root, 'assets/app-eZr2sdaR.js'))
    expect(brotliDecompressSync(await readFile(join(root, script.variants.br!.path)))).toEqual(original)
    expect(gunzipSync(await readFile(join(root, script.variants.gzip!.path)))).toEqual(original)
    expect(report.files).toBe(4)
    expect(report.variants).toBe(6)
    expect((await stored(root)).toSorted()).toEqual(listed(files).toSorted())
  })

  // Below 1 KiB a compressed copy saves less than the headers of the request that asks for it.
  it('writes no variant for a file under 1 KiB, and both for one of 1 KiB', async () => {
    await writeFile(join(root, 'small.txt'), 'a'.repeat(1023))
    await writeFile(join(root, 'large.txt'), 'a'.repeat(1024))

    await buildStatic({ root })
    const { files } = await readManifest(root)

    expect(files['favicon.svg']!.variants).toEqual({})
    expect(files['small.txt']!.variants).toEqual({})
    expect(Object.keys(files['large.txt']!.variants)).toEqual(['br', 'gzip'])
  })

  // A variant saving under 5% would cost a second file and a second ETag for nothing.
  it('keeps no variant that saves less than 5%', async () => {
    await writeFile(join(root, 'random.txt'), noise(2048))

    const report = await buildStatic({ root })
    const { files } = await readManifest(root)

    expect(files['random.txt']!.variants).toEqual({})
    expect(report.variants).toBe(6)
    expect((await stored(root)).toSorted()).toEqual(listed(files).toSorted())
  })

  // A deployment that builds twice must not change every ETag, nor a CDN cache with them.
  it('writes the same bytes when built twice in place', async () => {
    await buildStatic({ root })
    const first = await snapshot(root)

    const report = await buildStatic({ root })

    expect(await snapshot(root)).toEqual(first)
    expect(report.skipped.filter(({ reason }) => reason === 'variant')).toHaveLength(6)
    expect(report.skipped.filter(({ reason }) => reason === 'manifest')).toHaveLength(1)
  })

  // The variants are the build's own: a rebuild must neither keep a deleted file's nor publish them as files.
  it('removes the variants of a file deleted since the last build', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    const before = listed((await readManifest(root)).files)
    await rm(join(root, 'manual.txt'))

    const report = await buildStatic({ root })
    const { files } = await readManifest(root)

    expect(Object.keys(files).filter(path => path.startsWith('manual'))).toEqual([])
    expect((await stored(root)).toSorted()).toEqual(listed(files).toSorted())
    expect(listed(files)).toHaveLength(before.length - 2)
    expect(report.files).toBe(4)
  })

  // Two files of the same bytes share their variants: deleting one must not take the other's away.
  it('keeps the variants a deleted file shared with a file still there', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await writeFile(join(root, 'copy.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    await rm(join(root, 'manual.txt'))

    await buildStatic({ root })
    const copy = (await readManifest(root)).files['copy.txt']!

    expect(gunzipSync(await readFile(join(root, copy.variants.gzip!.path))).toString()).toBe('manual '.repeat(400))
  })

  // The build writes nothing beside a file of the site, so an archive there is the site's to serve.
  it('serves an archive beside a file it compresses as a file of its own, and leaves it as it was', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await writeFile(join(root, 'manual.txt.gz'), 'an archive of its own')

    await buildStatic({ root })
    const { files } = await readManifest(root)

    expect(Object.keys(files).filter(path => path.startsWith('manual'))).toEqual(['manual.txt', 'manual.txt.gz'])
    expect(files['manual.txt.gz']!.type).toBe('application/gzip')
    expect(Object.keys(files['manual.txt']!.variants)).toEqual(['br', 'gzip'])
    expect(await readFile(join(root, 'manual.txt.gz'), 'utf8')).toBe('an archive of its own')
  })

  // A build stopped between two variants must leave the site as the last manifest describes it, and the next build of
  // either input must succeed.
  it('leaves the previous manifest and its variants whole when stopped before its own manifest', async () => {
    const first = 'first '.repeat(400)
    const second = 'second '.repeat(400)
    const originalTime = 1_700_000_000.99975
    await writeFile(join(root, 'manual.txt'), first)
    await utimes(join(root, 'manual.txt'), originalTime, originalTime)
    await buildStatic({ root })
    const previous = await readFile(join(root, MANIFEST_FILE))
    // Where the second input's gzip variant goes, a directory: the build stops there, its brotli variant written.
    const blocked = (await variantsOf(second)).gzip!.path
    await mkdir(join(root, blocked))
    await writeFile(join(root, 'manual.txt'), second)

    await expect(buildStatic({ root })).rejects.toThrow()

    expect(await readFile(join(root, MANIFEST_FILE))).toEqual(previous)
    const kept = (await readManifest(root)).files['manual.txt']!.variants
    expect(brotliDecompressSync(await readFile(join(root, kept.br!.path))).toString()).toBe(first)
    expect(gunzipSync(await readFile(join(root, kept.gzip!.path))).toString()).toBe(first)

    await rm(join(root, blocked), { recursive: true })
    await writeFile(join(root, 'manual.txt'), first)
    // The input as it was, its time included: the manifest records the second it changed in.
    await utimes(join(root, 'manual.txt'), originalTime, originalTime)
    await buildStatic({ root })
    expect(await readFile(join(root, MANIFEST_FILE))).toEqual(previous)

    await writeFile(join(root, 'manual.txt'), second)
    await buildStatic({ root })
    const rebuilt = (await readManifest(root)).files['manual.txt']!.variants
    expect(gunzipSync(await readFile(join(root, rebuilt.gzip!.path))).toString()).toBe(second)
  })

  // A build that fails mid-write must leave nothing the next build reads as a file of the site.
  it('leaves no temporary behind when its manifest cannot be written, and the next build succeeds', async () => {
    await mkdir(join(root, MANIFEST_FILE))

    await expect(buildStatic({ root })).rejects.toThrow()
    expect((await readdir(join(root, VARIANT_DIRECTORY))).filter(name => name.endsWith('.tmp'))).toEqual([])

    await rm(join(root, MANIFEST_FILE), { recursive: true })
    await buildStatic({ root })
    expect(Object.keys((await readManifest(root)).files)).toHaveLength(4)
  })

  // A build killed outright leaves its temporaries, and a deleted file's variants may still be there: both are the
  // build's, and only those are.
  it('removes the temporaries and the variants no manifest lists, and nothing else of its directory', async () => {
    await mkdir(join(root, VARIANT_DIRECTORY))
    await writeFile(join(root, VARIANT_DIRECTORY, '.0123456789ab.tmp'), 'cut short')
    const gone = createHash('sha256').update('gone').digest('base64')
    const unlisted = variantPath(gone, gone, 'br')
    await writeFile(join(root, unlisted), 'gone')
    await writeFile(join(root, VARIANT_DIRECTORY, 'notes.txt'), 'notes of its own')

    const report = await buildStatic({ root })
    const { files } = await readManifest(root)

    expect((await stored(root)).toSorted()).toEqual(listed(files).toSorted())
    expect(await readFile(join(root, VARIANT_DIRECTORY, 'notes.txt'), 'utf8')).toBe('notes of its own')
    expect(report.skipped).toContainEqual({ path: `${VARIANT_DIRECTORY}/notes.txt`, reason: 'variant' })
  })

  // A link would have the build write, and remove, wherever it points.
  it('refuses a symlink where it keeps its variants, and writes nothing through it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'caffeine-outside-'))

    try {
      await writeFile(join(outside, 'notes.txt'), 'notes of its own')
      await symlink(outside, join(root, VARIANT_DIRECTORY))

      const err = await buildStatic({ root }).catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticBuild)
      expect((err as Error).message.split('\n')[0]).toBe(
        `Cannot build static files from "${root}": "${VARIANT_DIRECTORY}" is not a directory, and the build keeps the variants there`,
      )
      expect(await readdir(outside)).toEqual(['notes.txt'])
      expect((await readdir(root)).includes(MANIFEST_FILE)).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses a file where it keeps its variants, and leaves it', async () => {
    await writeFile(join(root, VARIANT_DIRECTORY), 'notes of its own')

    await expect(buildStatic({ root })).rejects.toThrow(ErrStaticBuild)
    expect(await readFile(join(root, VARIANT_DIRECTORY), 'utf8')).toBe('notes of its own')
  })

  // A path is the site's text: written as a key, "__proto__" must stay a file, not set the manifest's prototype.
  it('lists a typed file named __proto__ in the report and the manifest', async () => {
    await writeFile(join(root, '__proto__'), 'proto')

    const report = await buildStatic({ root, types: { ['__proto__']: 'text/plain' } })
    const { files } = await readManifest(root)

    expect(report.files).toBe(5)
    expect(Object.hasOwn(files, '__proto__')).toBe(true)
    expect(files['__proto__']!.size).toBe(5)
  })

  // Node reads no file past 2 GiB into one buffer; one large video must not stop the whole build. Sparse, so it
  // takes no disk.
  it('lists a file of 2 GiB, hashing it as it is read', { timeout: 60_000 }, async () => {
    const video = join(root, 'video.mp4')
    await writeFile(video, '')
    await truncate(video, 2 ** 31)

    await buildStatic({ root })
    const file = (await readManifest(root)).files['video.mp4']!

    expect(file.size).toBe(2 ** 31)
    expect(file.hash).toBe(
      createHash('sha256')
        .update(Buffer.alloc(2 ** 30))
        .update(Buffer.alloc(2 ** 30))
        .digest('base64'),
    )
  })

  it.each(['', 'text/plain\ninvalid', 'text/plain; name=漢'])(
    'refuses a content type it cannot publish (%j)',
    async type => {
      await writeFile(join(root, 'data.txt'), 'x')

      await expect(buildStatic({ root, types: { '.txt': type } })).rejects.toThrow(ErrStaticBuild)
      expect((await readdir(root)).includes(MANIFEST_FILE)).toBe(false)
    },
  )

  it('refuses a tree with a file nothing types and writes no manifest', async () => {
    await writeFile(join(root, 'data.xyz'), 'x')

    await expect(buildStatic({ root })).rejects.toThrow(ErrStaticBuild)
    expect((await readdir(root)).includes(MANIFEST_FILE)).toBe(false)
  })
})

/** Every file in the build's directory under `root` named as a variant, as a root-relative path. */
async function stored(root: string): Promise<string[]> {
  const names = await readdir(join(root, VARIANT_DIRECTORY))

  return names
    .filter(name => /^[\w-]{43}\.[\w-]{43}\.(?:br|gz)$/.test(name))
    .map(name => `${VARIANT_DIRECTORY}/${name}`)
}

/** Every variant path `files` lists, once each. */
function listed(files: StaticManifest['files']): string[] {
  return [...new Set(Object.values(files).flatMap(file => Object.values(file.variants).map(variant => variant.path)))]
}

/** The variants a build writes for a file holding `text`, built in a directory of their own. */
async function variantsOf(text: string): Promise<ManifestFile['variants']> {
  const scratch = await mkdtemp(join(tmpdir(), 'caffeine-variants-'))

  try {
    await writeFile(join(scratch, 'manual.txt'), text)
    await buildStatic({ root: scratch })

    return (await readManifest(scratch)).files['manual.txt']!.variants
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const names = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())

  return Object.fromEntries(
    await Promise.all(
      names.map(async entry => {
        const path = join(entry.parentPath, entry.name)
        return [path, (await readFile(path)).toString('base64')] as const
      }),
    ),
  )
}
