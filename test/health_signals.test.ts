import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const FIXTURE = fileURLToPath(new URL('./fixtures/graceful_shutdown_app.mjs', import.meta.url))

interface Running {
  child: ChildProcess
  port: number
  output: () => string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

let running: Running | undefined

afterEach(() => {
  if (running !== undefined && running.child.exitCode === null) {
    running.child.kill('SIGKILL')
  }
  running = undefined
})

async function launch(env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, NODE_ENV: 'production', VITEST: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Application did not start: ${stdout}${stderr}`)), 15_000)

    const check = (): void => {
      const match = /listening (\d+)/.exec(stdout)
      if (match !== null) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }

    child.stdout.on('data', check)
    child.on('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Application exited before listening: ${stdout}${stderr}`))
    })
    check()
  })

  running = { child, port, output: () => stdout, exit }

  return running
}

// A single retry absorbs the rare transient ECONNRESET a CI runner's socket layer produces under load;
// it is not how the drain-window race is avoided (see waitForStatus below for that).
const probe = async (port: number, path: string): Promise<Response> => {
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`)
  } catch {
    return fetch(`http://127.0.0.1:${port}${path}`)
  }
}

// Polls instead of sleeping a fixed delay: `beginDrain` flips readiness synchronously when the signal is
// received, so this returns almost immediately — well inside the drain window — regardless of how loaded
// the CI runner is. A fixed sleep raced that window and could land after the process had already torn down.
async function waitForStatus(port: number, path: string, want: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastStatus: number | undefined
  while (Date.now() < deadline) {
    lastStatus = (await probe(port, path)).status
    if (lastStatus === want) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  throw new Error(`Timed out waiting for ${path} to return ${want}, last saw ${String(lastStatus)}`)
}

describe('graceful shutdown on signals', () => {
  it('drains on SIGTERM and exits cleanly', async () => {
    const app = await launch({ DRAIN_DELAY: '400' })

    expect((await probe(app.port, '/readyz')).status).toBe(200)

    app.child.kill('SIGTERM')

    // Mid-drain: readiness already refuses, liveness is still fine, and real traffic is still served.
    await waitForStatus(app.port, '/readyz', 503)

    expect((await probe(app.port, '/livez')).status).toBe(200)

    const result = await app.exit

    expect(result.code).toBe(0)
    expect(app.output()).toContain('container-disposed')
  }, 30_000)

  it('runs the shutdown hooks only after the drain delay', async () => {
    const app = await launch({ DRAIN_DELAY: '600' })

    const startedAt = Date.now()
    app.child.kill('SIGTERM')

    await app.exit

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550)
  }, 30_000)

  it('exits immediately on a second signal', async () => {
    const app = await launch({ DRAIN_DELAY: '10000' })

    app.child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 200))
    app.child.kill('SIGTERM')

    const result = await app.exit

    // 128 + SIGTERM. The drain was still running, so the clean path would have exited 0 much later.
    expect(result.code).toBe(143)
  }, 30_000)

  it('drains on SIGINT too, so a local Ctrl+C behaves like a rolling deploy', async () => {
    const app = await launch({ DRAIN_DELAY: '100' })

    app.child.kill('SIGINT')

    expect((await app.exit).code).toBe(0)
  }, 30_000)
})
