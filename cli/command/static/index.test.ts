import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(import.meta.dirname, '../../bin.ts')

describe('caffeine static', () => {
  let project: string

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'caffeine-cli-')))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, 'static', ...args], { encoding: 'utf8', cwd: project })
  }

  for (const args of [
    ['unknown', '--root', '.'],
    ['verify'],
    ['build', '--root'],
    ['build', '--root', '.', 'extra'],
    ['build', '--root', '.', '--watch'],
  ]) {
    it(`rejects invalid arguments: ${args.join(' ')}`, () => {
      const result = run(...args)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
    })
  }

  it('fails when the project has no static package', () => {
    const result = run('verify', '--root', '.')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('@caffeinejs/static')
  })

  it('uses the package and asset root from the selected project', async () => {
    const app = join(project, 'my app')
    const pkg = join(app, 'node_modules', '@caffeinejs', 'static')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { './build': './build.js' } }))
    await writeFile(
      join(pkg, 'build.js'),
      `export function buildStatic({ root }) {
        if (root !== ${JSON.stringify(join(app, 'web'))}) throw new Error(root)
        return { files: 3, variants: 2, bytes: 9 }
      }
      export function verifyStatic() {
        throw new Error('app.js')
      }`,
    )

    const args = ['--cwd', 'my app', '--root', 'web']
    const built = run('build', ...args)
    expect(built.status).toBe(0)
    expect(built.stdout.trim()).toBe('3 files, 2 variants, 9 bytes')

    const failed = run('verify', ...args)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('app.js')
    expect(failed.stdout).toBe('')
  })
})
