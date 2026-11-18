import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('./bin.mjs', import.meta.url))

describe.each([process.execPath, 'bun'])('caffeine-static via %s', runtime => {
  const run = (...args: string[]) => spawnSync(runtime, [entry, ...args], { encoding: 'utf8' })
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caffeine-static-cli-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('builds and verifies the staged root, then fails with the path of a changed asset', async () => {
    await writeFile(join(root, 'app.js'), 'hello')
    const built = run('build', '--root', root)
    expect(built.error).toBeUndefined()
    expect(built.status, built.stderr).toBe(0)
    expect(built.stdout.trim()).toBe('1 files, 0 variants, 5 bytes')

    const verified = run('verify', '--root', root)
    expect(verified.status, verified.stderr).toBe(0)
    expect(verified.stdout.trim()).toBe(built.stdout.trim())

    await writeFile(join(root, 'app.js'), 'stale')
    const failed = run('verify', '--root', root)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('app.js')
    expect(failed.stdout).toBe('')
  })

  it.each([['unknown', '--root', '.'], ['verify'], ['build', '--root'], ['build', '--root', '.', 'extra']])(
    'reports usage for invalid arguments',
    (...args) => {
      const result = run(...args)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--root DIR')
      expect(result.stdout).toBe('')
    },
  )
})

it('links the workspace executable when npm installs before compilation', async ({ onTestFinished }) => {
  const project = await mkdtemp(join(tmpdir(), 'caffeine-static-workspace-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))

  const source = fileURLToPath(new URL('.', import.meta.url))
  const workspace = join(project, 'static-cli')
  await cp(source, workspace, {
    recursive: true,
    filter: path => !['dist', 'node_modules'].includes(basename(path)),
  })
  // Exercise npm's workspace-bin linking offline, independent of registry dependencies.
  const { name, version, type, bin } = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name, version, type, bin }))
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, workspaces: ['static-cli'] }))
  const options = { cwd: project, encoding: 'utf8', shell: process.platform === 'win32' } as const
  const installed = spawnSync(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', 'cache'],
    options,
  )
  expect(installed.status, installed.stderr).toBe(0)
  // Make the real compiled workspace available only after npm has finished installing.
  await symlink(join(source, 'dist'), join(workspace, 'dist'), 'junction')

  const command = process.platform === 'win32' ? 'caffeine-static.cmd' : 'caffeine-static'
  const result = spawnSync(join('node_modules', '.bin', command), [], options)
  expect(result.status, result.stderr).toBe(2)
  expect(result.stderr).toContain('--root DIR')
})
