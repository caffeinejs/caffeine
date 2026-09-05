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
  builtPath: string
}

const servers: ServerConfig[] = [
  {
    name: 'caffeine',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'authn', 'caffeine', 'caffeine.js')],
    port: 3040,
    builtPath: resolve(__dirname, '..', 'dist', 'authn', 'caffeine', 'caffeine.js'),
  },
  {
    name: 'nestjs',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'authn', 'nestjs', 'nestjs.js')],
    port: 3041,
    builtPath: resolve(__dirname, '..', 'dist', 'authn', 'nestjs', 'nestjs.js'),
  },
]

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'POST' })
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
      env: { ...process.env, PORT: String(server.port) },
      stdio: 'ignore',
    })

    const errors: string[] = []
    child.on('error', err => errors.push(err.message))

    const base = `http://127.0.0.1:${server.port}`

    try {
      await waitForReady(`${base}/token`)

      if (errors.length > 0) {
        throw new Error(`Server process errors: ${errors.join(', ')}`)
      }

      let accessToken = ''

      await t.test('POST /token returns access_token', async () => {
        const res = await fetch(`${base}/token`, { method: 'POST' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { access_token?: string }
        assert.equal(typeof body.access_token, 'string')
        assert.ok(body.access_token && body.access_token.length > 0)
        accessToken = body.access_token
      })

      await t.test('GET /protected without token returns 401', async () => {
        const res = await fetch(`${base}/protected`)
        assert.equal(res.status, 401)
      })

      await t.test('GET /protected with token returns 200 and empty body', async () => {
        const res = await fetch(`${base}/protected`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
        assert.equal(res.status, 200)
        assert.equal(await res.text(), '')
      })
    } finally {
      await killProcess(child)
      await new Promise(r => setTimeout(r, 300))
    }
  })
}
