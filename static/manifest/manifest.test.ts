import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrStaticManifest, MANIFEST_FILE, readManifest } from './manifest.js'

const committed = fileURLToPath(new URL('../_tests/_testdata/manifest', import.meta.url))

describe('readManifest', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caffeine-manifest-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function refusal(manifest: string | undefined): Promise<ErrStaticManifest> {
    if (manifest !== undefined) {
      await writeFile(join(root, MANIFEST_FILE), manifest)
    }

    const err = await readManifest(root).catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrStaticManifest)
    expect((err as ErrStaticManifest).code).toBe('ERR_STATIC_MANIFEST')

    return err as ErrStaticManifest
  }

  const firstLine = (err: Error) => err.message.split('\n')[0]

  it('reads the files a build listed, with their variants', async () => {
    const manifest = await readManifest(committed)

    expect(manifest.version).toBe(1)
    expect(Object.keys(manifest.files)).toEqual(['assets/app.js', 'favicon.svg'])
    expect(manifest.files['assets/app.js']!.variants.br).toEqual({
      hash: '3AaMjvOZO8KpKL/ledZHabZeRWKB93lFQCovYxMqhg4=',
      path: 'assets/app.js.br',
      size: 512,
    })
    expect(manifest.files['favicon.svg']!.variants).toEqual({})
  })

  // A deployment that forgot the build step must say which step, not answer every request with a 404.
  it('names the missing manifest and the two ways to get one', async () => {
    const err = await refusal(undefined)

    expect(firstLine(err)).toBe(`Cannot serve "${root}": ${MANIFEST_FILE} is missing`)
    expect(err.message).toContain('Run buildStatic({ root }) from @caffeinejs/static/build after the front-end build')
    expect(err.message).toContain("Use mode: 'scan' in development")
  })

  it('refuses a manifest that is no JSON', async () => {
    expect(firstLine(await refusal('{ "version": 1,'))).toBe(
      `Cannot serve "${root}": ${MANIFEST_FILE} is not valid JSON`,
    )
  })

  // Not missing, so rebuilding is not the fix: the message must not send the reader looking for a lost file.
  it('tells a manifest it cannot read from a missing one', async () => {
    await mkdir(join(root, MANIFEST_FILE))

    expect(firstLine(await refusal(undefined))).toBe(`Cannot serve "${root}": ${MANIFEST_FILE} cannot be read`)
  })

  // A truncated or hand-edited manifest fails at start-up, naming what is wrong, instead of as a TypeError on the
  // first request that reaches the broken part.
  it.each([
    ['an array', '[]', `${MANIFEST_FILE} does not hold an object`],
    ['null', 'null', `${MANIFEST_FILE} does not hold an object`],
    ['no version', JSON.stringify({ files: {} }), '"version" is not a number'],
    ['files that are a list', JSON.stringify({ version: 1, files: [] }), '"files" is not an object'],
  ])('refuses a document that is %s', async (_case, manifest, detail) => {
    expect(firstLine(await refusal(manifest))).toBe(`Cannot serve "${root}": ${detail}`)
  })

  // A manifest a later build wrote may mean things this server would misread.
  it('refuses a version it does not read', async () => {
    expect(firstLine(await refusal(JSON.stringify({ version: 2, files: {} })))).toBe(
      `Cannot serve "${root}": ${MANIFEST_FILE} is version 2, and this server reads version 1`,
    )
  })

  const file = {
    hash: 'rNsTc9F2GTnLXaozMiIymFKVgUZKkK+uOZJ+eu+O3UY=',
    lastModified: '2026-11-01T10:00:00.000Z',
    size: 97,
    type: 'image/svg+xml',
    variants: {},
  }

  it.each([
    ['a field left out', { 'a.svg': { ...file, hash: undefined } }, '"files.a.svg.hash" is not a base64 SHA-256'],
    ['a negative size', { 'a.svg': { ...file, size: -1 } }, '"files.a.svg.size" is not a number'],
    [
      'a time that is no time',
      { 'a.svg': { ...file, lastModified: 'yesterday' } },
      '"files.a.svg.lastModified" is not an ISO 8601 time',
    ],
    ['a path out of the root', { '../a.svg': file }, '"files.../a.svg" is not a relative path under the root'],
    [':x.svg', { ':x.svg': file }, '":x.svg" holds ":", which the router reads as a parameter'],
    ['a path not in Unicode NFC', { 'cafe\u0301.svg': file }, '"cafe\u0301.svg" is not in Unicode NFC'],
    [
      'a type that would break the header',
      { 'a.svg': { ...file, type: 'image/svg+xml\r\nx-injected: 1' } },
      '"files.a.svg.type" is not a header value',
    ],
    [
      'a dotfile',
      { 'config/.env': file },
      '"files.config/.env" has a segment starting with ".", which is never served',
    ],
    ['a file that is not an object', { 'a.svg': 'a.svg' }, '"files.a.svg" is not an object'],
    ['an empty type', { 'a.svg': { ...file, type: '' } }, '"files.a.svg.type" is not a string'],
    ['variants that are a list', { 'a.svg': { ...file, variants: [] } }, '"files.a.svg.variants" is not an object'],
    [
      'a variant that is not an object',
      { 'a.svg': { ...file, variants: { br: 'a.svg.br' } } },
      '"files.a.svg.variants.br" is not an object',
    ],
    [
      'an encoding it does not read',
      { 'a.svg': { ...file, variants: { zstd: {} } } },
      '"files.a.svg.variants.zstd" is not an encoding this server reads',
    ],
    [
      'a variant out of the root',
      { 'a.svg': { ...file, variants: { br: { hash: file.hash, path: '/etc/passwd', size: 1 } } } },
      '"files.a.svg.variants.br.path" is not "a.svg.br", the path the build writes it at',
    ],
    // A variant's bytes are sent as the file's: a hand-written manifest must not publish `.env` through one.
    [
      'a variant that points at a dotfile',
      { 'a.svg': { ...file, variants: { gzip: { hash: file.hash, path: '.env', size: 1 } } } },
      '"files.a.svg.variants.gzip.path" is not "a.svg.gz", the path the build writes it at',
    ],
    [
      "a variant at another file's path",
      { 'a.svg': { ...file, variants: { br: { hash: file.hash, path: 'b.svg.br', size: 1 } } } },
      '"files.a.svg.variants.br.path" is not "a.svg.br", the path the build writes it at',
    ],
  ])('refuses %s, naming the field', async (_case, files, detail) => {
    expect(firstLine(await refusal(JSON.stringify({ version: 1, files })))).toBe(`Cannot serve "${root}": ${detail}`)
  })

  // The dot-segment rule must not cost an application its ACME challenge or security.txt.
  it('reads a file under a leading .well-known, and no other dot segment', async () => {
    await writeFile(
      join(root, MANIFEST_FILE),
      JSON.stringify({ version: 1, files: { '.well-known/security.txt': file } }),
    )

    expect(Object.keys((await readManifest(root)).files)).toEqual(['.well-known/security.txt'])
    expect(firstLine(await refusal(JSON.stringify({ version: 1, files: { 'a/.well-known/x.txt': file } })))).toBe(
      `Cannot serve "${root}": "files.a/.well-known/x.txt" has a segment starting with ".", which is never served`,
    )
  })
})
