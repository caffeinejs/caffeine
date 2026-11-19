import { execFile } from 'node:child_process'
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const fixtures = new URL('./fixtures/portable-email/', import.meta.url)
const require = createRequire(import.meta.url)
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const workerd = (require('workerd') as { default: string }).default

describe('portable email consumer', { timeout: 30_000 }, () => {
  let project: string

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'caffeine-portable-email-'))
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await copyFile(new URL('tsconfig.json', fixtures), join(project, 'tsconfig.json'))
    await copyFile(new URL('consumer.ts.in', fixtures), join(project, 'consumer.ts'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  function typecheck() {
    return run(process.execPath, [tsc, '--project', 'tsconfig.json', '--pretty', 'false'], { cwd: project })
  }

  function bundle(entry: string) {
    return build({
      absWorkingDir: project,
      entryPoints: [entry],
      outfile: 'bundle.mjs',
      bundle: true,
      platform: 'browser',
      // Keep the runtime read visible to workerd instead of substituting esbuild's browser default.
      define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
      format: 'esm',
      logLevel: 'silent',
    })
  }

  async function runWorker() {
    await copyFile(new URL('worker.mjs', fixtures), join(project, 'worker.mjs'))
    await copyFile(new URL('worker.capnp', fixtures), join(project, 'worker.capnp'))
    await bundle('worker.mjs')
    return run(workerd, ['test', 'worker.capnp'], { cwd: project })
  }

  it('type-checks and streams a Fetch response in a worker without runtime-specific globals', async () => {
    await typecheck()
    const { stdout, stderr } = await runWorker()
    expect(stdout + stderr).toContain('[ PASS ] portable-email')
  })

  it('exposes a JavaScript dependency that reads the Node environment at runtime', async () => {
    await writeFile(
      join(project, 'host-env.js'),
      "if (!process.env.NODE_ENV) {\n  throw new Error('Missing mode')\n}\n",
    )
    await appendFile(join(project, 'consumer.ts'), "\nimport './host-env.js'\n")
    await expect(runWorker()).rejects.toMatchObject({
      stderr: expect.stringContaining('ReferenceError: process is not defined'),
    })
  })

  it('rejects a deployment dependency that imports a Node builtin', async () => {
    await writeFile(join(project, 'consumer.ts'), "export { readFile } from 'node:fs/promises'\n")
    await expect(bundle('consumer.ts')).rejects.toThrow('Could not resolve "node:fs/promises"')
  })

  it('rejects a public package declaration that requires Node types', async () => {
    const dependency = join(project, 'node_modules', 'host-types')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.d.ts' }))
    await writeFile(join(dependency, 'index.d.ts'), 'export declare function payload(): Buffer\n')
    await writeFile(join(project, 'consumer.ts'), "export { payload } from 'host-types'\n")

    await expect(typecheck()).rejects.toMatchObject({
      stdout: expect.stringMatching(/host-types[/\\]index\.d\.ts[^\n]*Cannot find name 'Buffer'/),
    })
  })
})
