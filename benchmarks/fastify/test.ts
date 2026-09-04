import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerConfig {
  name: string
  cmd: string
  args: string[]
  port: number
  requiresBuild?: boolean
}

const servers: ServerConfig[] = [
  {
    name: 'fastify',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'fastify', 'bare.js')],
    port: 3030,
    requiresBuild: true,
  },
  {
    name: 'fastify-fetch',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'fastify', 'fetch.js')],
    port: 3031,
    requiresBuild: true,
  },
]

const URL_PATH = '/api/test/hello/42/true?text=world&num=7&bool=false'
const REQ_BODY = JSON.stringify({ text: 'test', num: 99, bool: true })
const REQ_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  text: 'hello',
  num: '42',
  bool: 'true',
}

const EXPECTED = {
  url: URL_PATH,
  params: { text: 'hello', num: '42', bool: 'true' },
  query: { text: 'world', num: '7', bool: 'false' },
  headers: { text: 'hello', num: '42', bool: 'true' },
  body: { text: 'test', num: 99, bool: true },
}

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
    if (server.requiresBuild) {
      try {
        await access(server.args[0])
      } catch {
        t.skip(`Build not found — run: npm run build -w @caffeinejs/benchmarks`)
        return
      }
    }

    const child = spawn(server.cmd, server.args, {
      env: { ...process.env, PORT: String(server.port) },
      stdio: 'ignore',
    })

    const errors: string[] = []
    child.on('error', err => errors.push(err.message))

    try {
      await waitForReady(`http://127.0.0.1:${server.port}/health`)

      if (errors.length > 0) {
        throw new Error(`Server process errors: ${errors.join(', ')}`)
      }

      const url = `http://127.0.0.1:${server.port}${URL_PATH}`

      await t.test('GET /health returns ok', async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/health`)
        assert.equal(res.status, 200)
        const body = (await res.json()) as Record<string, unknown>
        assert.deepEqual(body, { ok: true })
      })

      await t.test('POST with valid request returns expected body', async () => {
        const res = await fetch(url, {
          method: 'POST',
          body: REQ_BODY,
          headers: REQ_HEADERS,
        })

        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), EXPECTED)
      })
    } finally {
      await killProcess(child)
      await new Promise(r => setTimeout(r, 300))
    }
  })
}
