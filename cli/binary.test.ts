import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMusl, platformPackage, type resolveBinary } from './binary.js'
import { install } from './binary.testkit.js'

/** The installed copy's `resolveBinary`, which resolves from where that copy is installed. */
async function installed(path: string): Promise<typeof resolveBinary> {
  const module = (await import(path)) as { resolveBinary: typeof resolveBinary }
  return module.resolveBinary
}

describe('platformPackage()', () => {
  // A release publishes the binaries under these names, and every install asks for them: renaming one breaks both.
  test.each([
    ['linux', 'x64', false, '@caffeinejs/cli-linux-x64'],
    ['linux', 'arm64', false, '@caffeinejs/cli-linux-arm64'],
    ['linux', 'x64', true, '@caffeinejs/cli-linux-x64-musl'],
    ['linux', 'arm64', true, '@caffeinejs/cli-linux-arm64-musl'],
    ['darwin', 'x64', false, '@caffeinejs/cli-darwin-x64'],
    ['darwin', 'arm64', false, '@caffeinejs/cli-darwin-arm64'],
    ['win32', 'x64', false, '@caffeinejs/cli-win32-x64'],
  ] as const)('names the package for %s %s, musl %p', (platform, arch, musl, name) => {
    expect(platformPackage(platform, arch, musl)).toBe(name)
  })
})

describe('isMusl()', () => {
  test('is false for a report that carries the glibc runtime version', () => {
    expect(isMusl({ header: { glibcVersionRuntime: '2.39' } })).toBe(false)
  })

  test('is true for a report without one, as on Alpine', () => {
    expect(isMusl({ header: {} })).toBe(true)
  })
})

describe('resolveBinary()', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caffeine-binary-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('returns the binary of the platform package, even beside a compiled one', async () => {
    const installation = await install(dir, { platform: 'exit 0', compiled: 'exit 0' })
    const resolve = await installed(installation.binary)

    expect(await realpath(resolve())).toBe(await realpath(installation.platformBinary))
  })

  test('returns the compiled binary beside it when no platform package is installed, as in a clone', async () => {
    const installation = await install(dir, { compiled: 'exit 0' })
    const resolve = await installed(installation.binary)

    expect(await realpath(resolve())).toBe(await realpath(installation.compiledBinary))
  })

  test('throws ErrBinaryNotFound naming the package to install when there is neither', async () => {
    const installation = await install(dir)
    const resolve = await installed(installation.binary)

    let error: unknown
    try {
      resolve()
    } catch (err) {
      error = err
    }

    expect(error).toMatchObject({ name: 'ErrBinaryNotFound', code: 'ERR_BINARY_NOT_FOUND' })
    expect((error as Error).message.split('\n')[0]).toBe(
      `Cannot find the caffeine binary: "${installation.platformPackage}", which holds it for this platform, is not installed`,
    )
  })

  // Node runs the plugins and the launcher, and says why an installed package cannot be resolved; Bun reports it as
  // not found. Advice to reinstall would not help, so the cause must come through.
  test('lets through why an installed platform package cannot be resolved', async () => {
    const installation = await install(dir, { platform: 'exit 0' })
    await writeFile(
      join(dirname(dirname(installation.platformBinary)), 'package.json'),
      JSON.stringify({ name: installation.platformPackage, exports: { '.': './index.js' } }),
    )
    const script = [
      `import { resolveBinary } from ${JSON.stringify(pathToFileURL(installation.binary).href)}`,
      'try { resolveBinary() } catch (err) { console.log(err.code) }',
    ].join('\n')

    const result = spawnSync('node', ['--input-type=module', '--eval', script], { encoding: 'utf8' })

    expect(result.stdout).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED\n')
  })
})
