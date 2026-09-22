import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PRODUCTS } from './payload.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerConfig {
  name: string
  cmd: string
  args: string[]
  port: number
  builtPath: string
  env?: Record<string, string>
  /** What the cache status header must say on a first and on a second request; absent where none is sent. */
  cacheStatus?: [first: string | null, second: string | null]
}

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'caching', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'caffeine', cmd: 'node', port: 3050, cacheStatus: ['MISS', 'HIT'], ...built('caffeine', 'caffeine.js') },
  {
    name: 'caffeine (no cache)',
    cmd: 'node',
    port: 3051,
    env: { BENCH_CACHE: 'off' },
    cacheStatus: [null, null],
    ...built('caffeine', 'caffeine.js'),
  },
  { name: 'nestjs', cmd: 'node', port: 3052, ...built('nestjs', 'nestjs.js') },
  { name: 'nestjs (no cache)', cmd: 'node', port: 3053, env: { BENCH_CACHE: 'off' }, ...built('nestjs', 'nestjs.js') },
]

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return
      }
    } catch {
      // not ready
    }
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`Server not ready within ${timeoutMs}ms: ${url}`)
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.kill('SIGTERM')
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
  })
}

for (const server of servers) {
  void test(server.name, async t => {
    try {
      await access(server.builtPath)
    } catch {
      t.skip(`Build not found at ${server.builtPath} — run: npm run build -w @caffeinejs/benchmarks`)
      return
    }

    const child = spawn(server.cmd, server.args, {
      env: { ...process.env, ...server.env, PORT: String(server.port) },
      stdio: 'ignore',
    })

    const errors: string[] = []
    child.on('error', err => errors.push(err.message))

    const base = `http://127.0.0.1:${server.port}`

    try {
      await waitForReady(`${base}/health`)

      if (errors.length > 0) {
        throw new Error(`Server process errors: ${errors.join(', ')}`)
      }

      await t.test('GET /health returns ok', async () => {
        const res = await fetch(`${base}/health`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), { ok: true })
      })

      await t.test('GET /api/products returns the product list, twice', async () => {
        const first = await fetch(`${base}/api/products`)
        assert.equal(first.status, 200)
        assert.match(first.headers.get('content-type') ?? '', /application\/json/)
        assert.deepEqual(await first.json(), PRODUCTS)

        const second = await fetch(`${base}/api/products`)
        assert.equal(second.status, 200)
        assert.deepEqual(await second.json(), PRODUCTS)

        if (server.cacheStatus !== undefined) {
          assert.equal(first.headers.get('x-cache'), server.cacheStatus[0])
          assert.equal(second.headers.get('x-cache'), server.cacheStatus[1])
        }
      })
    } finally {
      await killProcess(child)
      await new Promise(r => setTimeout(r, 300))
    }
  })
}
