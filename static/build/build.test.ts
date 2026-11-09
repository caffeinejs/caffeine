import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MANIFEST_FILE, readManifest } from '../manifest/manifest.js'
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

  it('writes both variants beside each compressible file, and lists them in the manifest', async () => {
    const report = await buildStatic({ root })
    const { files } = await readManifest(root)
    const script = files['assets/app-eZr2sdaR.js']!

    expect(Object.keys(files)).toEqual([
      'assets/app-eZr2sdaR.js',
      'assets/style-A1b2C3d4.css',
      'favicon.svg',
      'index.html',
    ])
    expect(script.variants.br!.path).toBe('assets/app-eZr2sdaR.js.br')
    expect(script.variants.gzip!.path).toBe('assets/app-eZr2sdaR.js.gz')

    const original = await readFile(join(root, 'assets/app-eZr2sdaR.js'))
    expect(brotliDecompressSync(await readFile(join(root, script.variants.br!.path)))).toEqual(original)
    expect(gunzipSync(await readFile(join(root, script.variants.gzip!.path)))).toEqual(original)
    expect(report.files).toBe(4)
    expect(report.variants).toBe(6)
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

    await buildStatic({ root })

    expect((await readManifest(root)).files['random.txt']!.variants).toEqual({})
    expect((await readdir(root)).filter(name => name.startsWith('random.txt'))).toEqual(['random.txt'])
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

  // A deleted file's variants are the build's own: a rebuild must neither fail on them nor publish them as files.
  it('drops the variants of a file deleted since the last build', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    await rm(join(root, 'manual.txt'))

    const report = await buildStatic({ root })
    const { files } = await readManifest(root)

    expect(Object.keys(files).filter(path => path.startsWith('manual'))).toEqual([])
    expect((await readdir(root)).filter(name => name.startsWith('manual'))).toEqual([])
    expect(report.files).toBe(4)
  })

  it('drops an orphaned gzip variant left alone, which would otherwise be served as a .gz file', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    await rm(join(root, 'manual.txt'))
    await rm(join(root, 'manual.txt.br'))

    await buildStatic({ root })

    expect(Object.keys((await readManifest(root)).files).filter(path => path.startsWith('manual'))).toEqual([])
  })

  // Only the bytes the build wrote are its own: a file put at a former variant's path is the site's, and is served.
  it('keeps a file written over an orphaned variant', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    await rm(join(root, 'manual.txt'))
    await rm(join(root, 'manual.txt.br'))
    await writeFile(join(root, 'manual.txt.gz'), 'an archive of its own')

    await buildStatic({ root })

    expect(Object.keys((await readManifest(root)).files).filter(path => path.startsWith('manual'))).toEqual([
      'manual.txt.gz',
    ])
    expect(await readFile(join(root, 'manual.txt.gz'), 'utf8')).toBe('an archive of its own')
  })

  // A name beside a file is reserved for its variant, but only bytes a build recorded are the build's to delete.
  it('keeps an archive beside a file it never compressed, and serves neither as the other', async () => {
    await writeFile(join(root, 'manual.txt'), 'short')
    await writeFile(join(root, 'manual.txt.gz'), 'an archive of its own')

    const report = await buildStatic({ root })

    expect(await readFile(join(root, 'manual.txt.gz'), 'utf8')).toBe('an archive of its own')
    expect(report.skipped).toContainEqual({ path: 'manual.txt.gz', reason: 'reserved' })
    expect(Object.keys((await readManifest(root)).files).filter(path => path.startsWith('manual'))).toEqual([
      'manual.txt',
    ])
  })

  it('refuses to write a variant over bytes it did not write, leaving them as they were', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await writeFile(join(root, 'manual.txt.gz'), 'an archive of its own')

    const err = await buildStatic({ root }).catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrStaticBuild)
    expect((err as Error).message.split('\n')[0]).toBe(
      `Cannot build static files from "${root}": "manual.txt.gz" holds bytes no build wrote, where the gzip variant of "manual.txt" goes`,
    )
    expect(await readFile(join(root, 'manual.txt.gz'), 'utf8')).toBe('an archive of its own')
    expect((await readdir(root)).filter(name => name.startsWith('.'))).toEqual([])
  })

  // A build stopped after writing its variants and before its manifest leaves the same bytes the next one writes.
  it('rebuilds over the variants of a build that wrote no manifest', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    await buildStatic({ root })
    await rm(join(root, MANIFEST_FILE))

    await buildStatic({ root })

    expect(Object.keys((await readManifest(root)).files['manual.txt']!.variants)).toEqual(['br', 'gzip'])
  })

  // A build that fails mid-write must leave nothing the next build reads as a file of the site.
  it('leaves no temporary behind when a write fails, so the next build succeeds', async () => {
    await writeFile(join(root, 'manual.txt'), 'manual '.repeat(400))
    // A directory where the variant goes: the rename onto it fails.
    await mkdir(join(root, 'manual.txt.br'))

    await expect(buildStatic({ root })).rejects.toThrow()
    await rm(join(root, 'manual.txt.br'), { recursive: true })

    await buildStatic({ root })
    expect((await readdir(root)).filter(name => name.startsWith('manual')).toSorted()).toEqual([
      'manual.txt',
      'manual.txt.br',
      'manual.txt.gz',
    ])
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

  it('refuses a tree with a file nothing types and writes no manifest', async () => {
    await writeFile(join(root, 'data.xyz'), 'x')

    await expect(buildStatic({ root })).rejects.toThrow(ErrStaticBuild)
    expect((await readdir(root)).includes(MANIFEST_FILE)).toBe(false)
  })
})

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
