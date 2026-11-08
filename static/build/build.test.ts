import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
