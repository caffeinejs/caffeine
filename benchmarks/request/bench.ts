import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import autocannon from 'autocannon'
import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerConfig {
  name: string
  cmd: string
  args: string[]
  port: number
  builtPath?: string
  env?: Record<string, string>
}

interface BenchResult {
  name: string
  reqPerSec: number
  latencyMs: number
  throughputMBs: number
}

const servers: ServerConfig[] = [
  {
    name: 'fastify',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'fastify', 'fastify.js')],
    port: 3020,
    builtPath: resolve(__dirname, '..', 'dist', 'request', 'fastify', 'fastify.js'),
  },
  {
    name: 'hono',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'hono', 'hono.js')],
    port: 3021,
    builtPath: resolve(__dirname, '..', 'dist', 'request', 'hono', 'hono.js'),
  },
  {
    name: 'nestjs',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'nestjs', 'nestjs.js')],
    port: 3022,
    builtPath: resolve(__dirname, '..', 'dist', 'request', 'nestjs', 'nestjs.js'),
  },
  {
    name: 'caffeine',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'caffeine', 'caffeine.js')],
    port: 3023,
    builtPath: resolve(__dirname, '..', 'dist', 'request', 'caffeine', 'caffeine.js'),
  },
  {
    name: 'elysia',
    cmd: 'node',
    args: [resolve(__dirname, '..', 'dist', 'request', 'elysia', 'elysia.js')],
    port: 3024,
    builtPath: resolve(__dirname, '..', 'dist', 'request', 'elysia', 'elysia.js'),
  },
]

const REQUEST_BODY = JSON.stringify({ text: 'test', num: 99, bool: true })
const REQUEST_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'benchmark',
  text: 'hello',
  num: '42',
  bool: 'true',
}

const READY_TIMEOUT = process.env.CI === 'true' ? 60_000 : 10_000

async function waitForReady(url: string, timeoutMs = READY_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

async function killProcess(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.kill('SIGTERM')
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
  })
}

async function clearPort(port: number): Promise<void> {
  const { execSync } = await import('node:child_process')
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim()
    if (pids) {
      execSync(`kill -9 ${pids.split('\n').join(' ')}`, { stdio: 'ignore' })
      await new Promise(r => setTimeout(r, 200))
    }
  } catch {
    // port is free or lsof not available
  }
}

let activeChild: ChildProcess | null = null

function shutdown(): void {
  if (activeChild) {
    activeChild.kill('SIGTERM')
    setTimeout(() => activeChild?.kill('SIGKILL'), 2000).unref()
  }
  process.exit(1)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function runServer(server: ServerConfig): Promise<BenchResult> {
  if (server.builtPath) {
    try {
      await access(server.builtPath)
    } catch {
      throw new Error(
        `Compiled output not found at: ${server.builtPath}\n`
        + `Run: npm run build -w @caffeinejs/benchmarks`,
      )
    }
  }

  const healthUrl = `http://127.0.0.1:${server.port}/health`
  const benchUrl = `http://127.0.0.1:${server.port}/api/test/hello/42/true?text=world&num=7&bool=false`

  await clearPort(server.port)

  const child = spawn(server.cmd, server.args, {
    env: { ...process.env, ...server.env, PORT: String(server.port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  activeChild = child
  child.on('error', err => {
    throw err
  })

  await waitForReady(healthUrl)

  const cannonOpts = {
    url: benchUrl,
    method: 'POST' as const,
    body: REQUEST_BODY,
    headers: REQUEST_HEADERS,
    connections: 100,
    pipelining: 10,
  }

  await autocannon({ ...cannonOpts, duration: 10 })

  const result = await autocannon({ ...cannonOpts, duration: 40 })

  activeChild = null
  await killProcess(child)
  await new Promise(r => setTimeout(r, 500))

  return {
    name: server.name,
    reqPerSec: result.requests.average,
    latencyMs: result.latency.average,
    throughputMBs: result.throughput.average / 1_048_576,
  }
}

function printTable(results: BenchResult[]): void {
  const c1 = 14, c2 = 14, c3 = 19, c4 = 23
  const line = `${'-'.repeat(c1)}+-${'-'.repeat(c2)}+-${'-'.repeat(c3)}+-${'-'.repeat(c4 - 2)}`
  const header
    = 'Framework'.padEnd(c1)
      + '| '
      + 'Req/sec avg'.padEnd(c2)
      + '| '
      + 'Latency avg (ms)'.padEnd(c3)
      + '| '
      + 'Throughput (MB/s)'

  console.log(`\n${header}\n${line}`)

  for (const r of results) {
    const row
      = r.name.padEnd(c1)
        + '| '
        + r.reqPerSec.toLocaleString().padStart(c2 - 1)
        + ' | '
        + r.latencyMs.toFixed(2).padStart(c3 - 1)
        + ' | '
        + r.throughputMBs.toFixed(2).padStart(c4 - 3)
    console.log(row)
  }

  console.log()
}

const results: BenchResult[] = []

for (const server of servers) {
  if (process.env.CI !== 'true') {
    console.log(`Benchmarking ${server.name}...`)
  }
  results.push(await runServer(server))
}

results.sort((a, b) => b.reqPerSec - a.reqPerSec)

printMachineInfo()
printTable(results)
