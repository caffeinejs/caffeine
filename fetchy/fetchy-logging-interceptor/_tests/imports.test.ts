import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

// The package's own directory, where it resolves its own name to its build, as an application resolves it.
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

// Imports the module named on the command line in a fresh process, then reports what the module exports and which of
// pino's own modules the import loaded on the way.
const PROBE = String.raw`
import { createRequire } from 'node:module'

const exported = await import(process.argv[1])
const pino = Object.keys(createRequire(import.meta.url).cache).filter(path => /[\\/]node_modules[\\/]pino[\\/]/.test(path))

console.log(JSON.stringify({ exports: Object.keys(exported), pino }))
`

async function probe(specifier: string): Promise<{ exports: string[]; pino: string[] }> {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', PROBE, specifier], { cwd: PACKAGE_DIR })

  return JSON.parse(stdout) as { exports: string[]; pino: string[] }
}

describe('importing the package', { timeout: 30_000 }, () => {
  // An application that logs through a logger of its own pays nothing for pino. The import used to load pino and start
  // the pino-pretty worker PinoLogger's default options named, in every process.
  it('loads no pino module from the root', async () => {
    const root = await probe('@caffeinejs/fetchy-logging-interceptor')

    expect(root.exports).toEqual(expect.arrayContaining(['ConsoleLogger', 'LoggingInterceptor']))
    expect(root.exports).not.toContain('PinoLogger')
    expect(root.pino).toEqual([])
  })

  // Also what shows the probe above sees pino when it is loaded.
  it('loads pino from the /pino subpath, which exports PinoLogger', async () => {
    const subpath = await probe('@caffeinejs/fetchy-logging-interceptor/pino')

    expect(subpath.exports).toEqual(['PinoLogger'])
    expect(subpath.pino).not.toEqual([])
  })
})
