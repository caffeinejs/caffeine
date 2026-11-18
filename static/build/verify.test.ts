import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MANIFEST_FILE, type Encoding, type StaticManifest, variantPath } from '../manifest/manifest.js'
import { buildStatic } from './build.js'
import { verifyStatic } from './verify.js'

describe('verifyStatic', () => {
  const contents = 'x'.repeat(8192)
  let root: string
  let manifest: StaticManifest

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caffeine-verify-'))
    await writeFile(join(root, 'app.js'), contents)
    await buildStatic({ root })
    manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('checks all stored representations without rewriting the staged release', async () => {
    const identity = manifest.files['app.js']!
    const variants = Object.values(identity.variants)
    const paths = [MANIFEST_FILE, 'app.js', ...variants.map(v => v.path)]
    const mtimes = () => Promise.all(paths.map(async path => (await stat(join(root, path))).mtimeMs))
    const before = await mtimes()

    await expect(verifyStatic({ root })).resolves.toEqual({
      files: 1,
      variants: 2,
      bytes: identity.size + variants.reduce((sum, variant) => sum + variant.size, 0),
    })
    expect(await mtimes()).toEqual(before)
  })

  async function replaceVariant(encoding: Encoding, encoded: Buffer): Promise<string> {
    const identity = manifest.files['app.js']!
    const hash = createHash('sha256').update(encoded).digest('base64')
    const path = variantPath(identity.hash, hash, encoding)
    const variant = { hash, path, size: encoded.byteLength }

    await writeFile(join(root, path), encoded)
    await writeFile(
      join(root, MANIFEST_FILE),
      JSON.stringify({
        ...manifest,
        files: { 'app.js': { ...identity, variants: { [encoding]: variant } } },
      }),
    )

    return path
  }

  for (const encoding of ['br', 'gzip'] as const) {
    const encode = encoding === 'br' ? brotliCompressSync : gzipSync

    it(`rejects a valid, correctly hashed ${encoding} encoding of another same-size identity`, async () => {
      const path = await replaceVariant(encoding, encode('y'.repeat(contents.length)))
      const check = verifyStatic({ root })

      await expect(check).rejects.toThrow(path)
      await expect(check).rejects.toThrow("does not decode to the identity's length and SHA-256")
    })

    it(`stops excess ${encoding} output at the declared identity length`, async () => {
      await replaceVariant(encoding, encode(contents.repeat(10)))
      await expect(verifyStatic({ root })).rejects.toThrow(`more than the identity's ${contents.length} bytes`)
    })

    it(`rejects trailing bytes outside the complete ${encoding} representation`, async () => {
      const encoded = Buffer.concat([encode(contents), Buffer.alloc(1)])
      const path = await replaceVariant(encoding, encoded)
      const check = verifyStatic({ root })

      await expect(check).rejects.toThrow(path)
      await expect(check).rejects.toThrow('trailing bytes')
    })

    it(`rejects a truncated ${encoding} stream even when the stored digest is correct`, async () => {
      await replaceVariant(encoding, encode(contents).subarray(0, -4))
      await expect(verifyStatic({ root })).rejects.toThrow(`cannot be decoded as ${encoding}`)
    })
  }

  it('applies deployment-specific limits to the staged release', async () => {
    await expect(verifyStatic({ root, maxEntries: 0 })).rejects.toThrow('exceeds the limit of 0 identities')
    await expect(verifyStatic({ root, maxManifestSize: 16 })).rejects.toThrow('maxManifestSize')
    await expect(verifyStatic({ root, maxEntries: 1 })).resolves.toMatchObject({ files: 1, variants: 2 })
  })

  it('preserves an abort reason before opening a release', async () => {
    const reason = new Error('deployment cancelled')

    await expect(verifyStatic({ root, signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })
})
