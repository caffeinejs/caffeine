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
  env?: Record<string, string>
}

const servers: ServerConfig[] = [
  {
    name: 'fastify',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'fastify', 'fastify.js')],
    port: 3020,
    requiresBuild: true,
  },
  {
    name: 'hono',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'hono', 'hono.js')],
    port: 3021,
    requiresBuild: true,
  },
  {
    name: 'nestjs',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'nestjs', 'nestjs.js')],
    port: 3022,
    requiresBuild: true,
  },
  {
    name: 'caffeine',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'caffeine', 'caffeine.js')],
    port: 3023,
    requiresBuild: true,
  },
  {
    name: 'elysia',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'elysia', 'elysia.js')],
    port: 3024,
    requiresBuild: true,
  },
]

const URL_PATH = '/api/test/hello/42/true?text=world&num=7&bool=false'
const REQ_BODY = JSON.stringify({ text: 'test', num: 99, bool: true })
const REQ_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'x-api-key': 'benchmark',
  text: 'hello',
  num: '42',
  bool: 'true',
}

const EXPECTED_PARAMS = { text: 'hello', num: 42, bool: true }
const EXPECTED_QUERY = { text: 'world', num: 7, bool: false }
const EXPECTED_BODY = { text: 'test', num: 99, bool: true }
const EXPECTED_HEADER = { text: 'hello', num: 42, bool: true }

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
  test(server.name, async t => {
    if (server.requiresBuild) {
      try {
        await access(server.args[0])
      } catch {
        t.skip(`Build not found — run: npm run build -w @caffeinejs/benchmarks`)
        return
      }
    }

    const child = spawn(server.cmd, server.args, {
      env: { ...process.env, ...server.env, PORT: String(server.port) },
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
        const body = await res.json() as Record<string, unknown>
        assert.deepEqual(body, { ok: true })
      })

      await t.test('POST without api key returns 401', async () => {
        const res = await fetch(url, {
          method: 'POST',
          body: REQ_BODY,
          headers: { 'content-type': 'application/json' },
        })
        assert.equal(res.status, 401)
      })

      await t.test('POST with valid request returns expected body', async () => {
        const res = await fetch(url, {
          method: 'POST',
          body: REQ_BODY,
          headers: REQ_HEADERS,
        })

        assert.equal(res.status, 200)

        const body = await res.json() as {
          params: typeof EXPECTED_PARAMS
          query: typeof EXPECTED_QUERY
          body: typeof EXPECTED_BODY
          header: typeof EXPECTED_HEADER
          // big: unknown[]
        }

        assert.deepEqual(body.params, EXPECTED_PARAMS, 'params mismatch')
        assert.deepEqual(body.query, EXPECTED_QUERY, 'query mismatch')
        assert.deepEqual(body.body, EXPECTED_BODY, 'body mismatch')
        assert.deepEqual(body.header, EXPECTED_HEADER, 'header mismatch')
        // assert.ok(Array.isArray(body.big) && body.big.length === 200, 'big array wrong')
      })

      await t.test('response echoes headers', async () => {
        const res = await fetch(url, {
          method: 'POST',
          body: REQ_BODY,
          headers: REQ_HEADERS,
        })

        assert.equal(res.headers.get('text'), 'hello')
        assert.equal(res.headers.get('num'), '42')
        assert.equal(res.headers.get('bool'), 'true')
      })
    } finally {
      await killProcess(child)
      await new Promise(r => setTimeout(r, 300))
    }
  })
}
