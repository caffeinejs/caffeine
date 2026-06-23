import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import autocannon from 'autocannon'
import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT ?? '3000', 10)
const BASE_URL = `http://127.0.0.1:${PORT}/`

interface ServerConfig {
  name: string
  cmd: string
  args: string[]
  requiresBuild?: boolean
  url?: string
}

interface BenchResult {
  name: string
  reqPerSec: number
  latencyMs: number
  throughputMBs: number
}

const nestjsBuilt = resolve(__dirname, '..', 'dist', 'helloworld', 'nestjs.js')

const servers: ServerConfig[] = [
  {
    name: 'fastify',
    cmd: 'node',
    args: [resolve(__dirname, 'fastify.js')],
  },
  {
    name: 'express',
    cmd: 'node',
    args: [resolve(__dirname, 'express.js')],
  },
  {
    name: 'nestjs',
    cmd: 'node',
    args: [nestjsBuilt],
    requiresBuild: true,
  },
  {
    name: 'elysia',
    cmd: 'node',
    args: [resolve(__dirname, 'elysia.js')],
  },
  {
    name: 'hono',
    cmd: 'node',
    args: [resolve(__dirname, 'hono.js')],
  },
  {
    name: 'node:http',
    cmd: 'node',
    args: [resolve(__dirname, 'node-http.js')],
  },
  {
    name: 'adonisjs',
    cmd: 'node',
    args: [resolve(__dirname, 'adonisjs.js')],
  },
  {
    name: 'trpc',
    cmd: 'node',
    args: [resolve(__dirname, 'trpc.js')],
    url: `http://127.0.0.1:${PORT}/hello`,
  },
]

async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
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
  throw new Error(`Server on port ${PORT} did not become ready within ${timeoutMs}ms`)
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

async function runServer(server: ServerConfig): Promise<BenchResult> {
  if (server.requiresBuild) {
    try {
      await access(nestjsBuilt)
    } catch {
      throw new Error(
        `NestJS compiled output not found at: ${nestjsBuilt}\n`
        + `Run: npm run build -w @caffeinejs/benchmarks`,
      )
    }
  }

  const serverUrl = server.url ?? BASE_URL

  const child = spawn(server.cmd, server.args, {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  child.on('error', err => {
    throw err
  })

  await waitForReady(serverUrl)

  const result = await autocannon({ url: serverUrl, connections: 100, duration: 10 })

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
