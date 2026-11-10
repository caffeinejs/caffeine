import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrStaticBuild } from './errors.js'
import { scan } from './scan.js'

describe('scan', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caffeine-scan-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function tree(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), path)
    }
  }

  async function refusal(): Promise<string> {
    const err = await scan(root).catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrStaticBuild)
    expect((err as ErrStaticBuild).code).toBe('ERR_STATIC_BUILD')

    return (err as Error).message.split('\n')[0]!
  }

  // A dotfile is a secret more often than an asset: `.env` beside the bundle must never become a route.
  it('leaves out every dot segment but a leading .well-known', async () => {
    await tree(['.env', 'assets/.secret.js', '.git/config.txt', '.well-known/security.txt', 'a/.well-known/x.txt'])

    const { files, skipped } = await scan(root)

    expect(files.map(({ path }) => path)).toEqual(['.well-known/security.txt'])
    expect(skipped).toEqual([
      { path: '.env', reason: 'dotfile' },
      { path: '.git/config.txt', reason: 'dotfile' },
      { path: 'a/.well-known/x.txt', reason: 'dotfile' },
      { path: 'assets/.secret.js', reason: 'dotfile' },
    ])
  })

  // The build's own directory holds its variants, served only as a file's representations, never as files; beside a
  // file, a .gz is a file of the site like any other.
  it("leaves out the build's variants and the manifest, and reads x.gz beside x as a file of its own", async () => {
    await tree(['app.js', 'app.js.gz', '.static-variants/abc.br', 'static.manifest.json'])

    const { files, skipped } = await scan(root)

    expect(files).toEqual([
      { path: 'app.js', type: 'text/javascript; charset=utf-8', compressible: true },
      { path: 'app.js.gz', type: 'application/gzip', compressible: false },
    ])
    expect(skipped).toEqual([
      { path: '.static-variants/abc.br', reason: 'variant' },
      { path: 'static.manifest.json', reason: 'manifest' },
    ])
  })

  // A symlink can point out of the root; the server refuses one too, so the build never lists it.
  it('skips a symlink and reports it', async () => {
    await tree(['index.html'])
    await symlink(join(root, 'index.html'), join(root, 'alias.html'))

    const { files, skipped } = await scan(root)

    expect(files.map(({ path }) => path)).toEqual(['index.html'])
    expect(skipped).toEqual([{ path: 'alias.html', reason: 'symlink' }])
  })

  it('skips what exclude names, after the fixed rules', async () => {
    await tree(['index.html', 'stats.json', 'reports/a.html'])

    const { files, skipped } = await scan(root, { exclude: ['stats.json', 'reports/**'] })

    expect(files.map(({ path }) => path)).toEqual(['index.html'])
    expect(skipped).toEqual([
      { path: 'reports/a.html', reason: 'excluded' },
      { path: 'stats.json', reason: 'excluded' },
    ])
  })

  // Served as application/octet-stream, a browser would sniff it; the build stops and names the key to add.
  it('refuses a file with no extension and one whose extension nothing types, naming each', async () => {
    await tree(['LICENSE', 'data/a.xyz', 'data/b.xyz'])

    const err = (await scan(root).catch((err: unknown) => err)) as Error

    expect(await refusal()).toBe(
      `Cannot build static files from "${root}": no content type for "LICENSE", which has no extension; ` +
        `no content type for ".xyz" (2 files, such as "data/a.xyz")`,
    )
    expect(err.message).toContain(`Add the type to types: { 'LICENSE': '...', '.xyz': '...' }`)
  })

  // The first line stays one line a log keeps whole, however many files a build gets wrong.
  it('names five problems and counts the rest', async () => {
    await tree(['a.x1', 'a.x2', 'a.x3', 'a.x4', 'a.x5', 'a.x6', 'a.x7'])

    expect(await refusal()).toBe(
      `Cannot build static files from "${root}": ` +
        ['1', '2', '3', '4', '5'].map(n => `no content type for ".x${n}" (1 file, such as "a.x${n}")`).join('; ') +
        '; and 2 more',
    )
  })

  // Read like a file, a socket a dev server left in the output would fail the build, and a FIFO would hang it.
  it('skips what is not a regular file', async () => {
    await tree(['index.html'])
    const server = createServer()
    await new Promise<void>(resolve => server.listen(join(root, 'dev.sock'), resolve))

    try {
      const { files, skipped } = await scan(root)

      expect(files.map(({ path }) => path)).toEqual(['index.html'])
      expect(skipped).toEqual([{ path: 'dev.sock', reason: 'not-a-file' }])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('types a file types names', async () => {
    await tree(['LICENSE'])

    const { files } = await scan(root, { types: { LICENSE: 'text/plain' } })

    expect(files).toEqual([{ path: 'LICENSE', type: 'text/plain; charset=utf-8', compressible: true }])
  })

  // The router reads `:` and `*` as syntax: the file would answer as a pattern, or never as itself.
  it.each([
    [':id.js', '":id.js" holds ":", which the router reads as a parameter'],
    ['x*.js', '"x*.js" holds "*", which the router reads as a wildcard'],
    ['tab\t.js', '"tab\\u0009.js" holds a control character'],
    ['café.html', '"café.html" is not in Unicode NFC'],
  ])('refuses %j, which no URL reaches as itself', async (path, detail) => {
    await tree([path])

    expect(await refusal()).toBe(`Cannot build static files from "${root}": ${detail}`)
  })

  it('refuses a root that is not there', async () => {
    await rm(root, { recursive: true })

    expect(await refusal()).toBe(`Cannot build static files from "${root}": the root does not exist or cannot be read`)
  })
})
