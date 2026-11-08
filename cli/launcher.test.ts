import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'

import { install } from './binary.testkit.js'

/**
 * A binary that prints `ready`, runs `trap` on the signals it names, and otherwise ends by itself with `finished`
 * after about `seconds`, so that a launcher which keeps a signal fails a test rather than hangs it.
 */
function waiting(trap: string, seconds: number): string {
  return [
    trap,
    'echo ready',
    'i=0',
    `while [ $i -lt ${seconds * 20} ]; do sleep 0.05; i=$((i + 1)); done`,
    'echo finished',
  ].join('\n')
}

/** Starts the launcher with Node, and returns once the binary is ready, failing if the launcher ends first. */
async function start(launcher: string): Promise<{
  launcher: ChildProcess
  closed: Promise<[number | null, NodeJS.Signals | null]>
  output: () => string
}> {
  const child = spawn('node', [launcher], { stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  let output = ''
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('ready\n')) {
        resolve()
      }
    })
    child.on('close', code => {
      reject(new Error(`The launcher exited with ${code} before the binary was ready: ${JSON.stringify(output)}`))
    })
  })

  return { launcher: child, closed, output: () => output }
}

// npm runs the `caffeine` bin with Node, so these tests run the built launcher with Node.
describe('the caffeine launcher', () => {
  let dir: string

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'caffeine-launcher-')))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // An npm script that runs `caffeine generate` must fail when the generation fails.
  test('hands its arguments to the binary as they are, and exits with its code', async () => {
    const { launcher } = await install(dir, { platform: `printf '%s\\n' "$@"\nexit 3` })

    const result = spawnSync('node', [launcher, 'generate', 'modules', '--cwd', 'my app'], {
      encoding: 'utf8',
    })

    expect(result.stdout).toBe('generate\nmodules\n--cwd\nmy app\n')
    expect(result.status).toBe(3)
  })

  test('ends by the signal that ended the binary', async () => {
    const { launcher } = await install(dir, { platform: 'kill -TERM $$' })

    const result = spawnSync('node', [launcher])

    expect(result.signal).toBe('SIGTERM')
  })

  // Node ignores SIGPIPE and opens its inspector on SIGUSR1: raising either would not end the launcher, and SIGUSR1
  // would leave a debugger port open. The exit code still tells that the binary failed.
  test.each(['SIGPIPE', 'SIGUSR1'] as const)(
    'exits 128 plus the number of %s, which it cannot end by',
    async signal => {
      const { launcher } = await install(dir, { platform: `kill -${signal.slice(3)} $$` })

      const result = spawnSync('node', [launcher], { encoding: 'utf8' })

      expect(result.stderr).toBe('')
      expect(result.status).toBe(128 + constants.signals[signal])
    },
  )

  // A process manager stops `caffeine generate --watch` by signalling the launcher only: the binary must not run on.
  test('passes on a SIGTERM sent to it alone', async () => {
    const installed = await install(dir, { platform: waiting(`trap 'echo stopped; exit 7' TERM`, 5) })
    const { launcher, closed, output } = await start(installed.launcher)

    launcher.kill('SIGTERM')
    const [code] = await closed

    expect(output()).toBe('ready\nstopped\n')
    expect(code).toBe(7)
  }, 30_000)

  // A terminal sends SIGINT and SIGHUP to its whole foreground group, so the binary has them already: a second one
  // would cut its shutdown short.
  test.each(['SIGINT', 'SIGHUP'] as const)(
    'does not pass on %s, and waits for the binary to end',
    async signal => {
      const installed = await install(dir, { platform: waiting(`trap 'echo interrupted; exit 7' INT HUP`, 1) })
      const { launcher, closed, output } = await start(installed.launcher)

      launcher.kill(signal)
      const [code] = await closed

      expect(output()).toBe('ready\nfinished\n')
      expect(code).toBe(0)
    },
    30_000,
  )

  test('says which package to install when the binary is missing', async () => {
    const { launcher, platformPackage } = await install(dir)

    const result = spawnSync('node', [launcher], { encoding: 'utf8' })

    expect(result.stderr.split('\n')[0]).toBe(
      `[caffeine] Cannot find the caffeine binary: "${platformPackage}", which holds it for this platform, is not installed`,
    )
    expect(result.status).toBe(1)
  })

  // A binary built for another platform, or one that lost its mode, must be reported in a line, not a stack trace.
  test.each([
    ['is not executable', 0o644, '#!/bin/sh\nexit 0\n'],
    ['is in no format this platform runs', 0o755, '\u007fELF\u0002\u0001\u0001'],
  ])('reports a binary that %s, and exits 1', async (_, mode, content) => {
    const { launcher, platformBinary } = await install(dir, { platform: 'exit 0' })
    await writeFile(platformBinary, content)
    await chmod(platformBinary, mode)

    const result = spawnSync('node', [launcher], { encoding: 'utf8' })

    expect(result.stderr).toStartWith(`[caffeine] Cannot run "${platformBinary}": `)
    expect(result.stderr.split('\n').length).toBe(2)
    expect(result.status).toBe(1)
  })
})
