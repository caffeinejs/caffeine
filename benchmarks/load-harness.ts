import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'

import autocannon from 'autocannon'

import { printMachineInfo, printVersions } from './machine-info.js'

export interface ServerConfig {
  name: string
  /** Defaults to the Node binary running the harness, so the reported version is the measured one. */
  cmd?: string
  args: string[]
  port: number
  builtPath?: string
  env?: Record<string, string>
  /** Overrides the benchmark's request path for this server. */
  path?: string
  /** Overrides the benchmark's readiness path for this server. */
  readyPath?: string
}

export interface RequestSpec {
  path: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export interface LoadBenchmark {
  servers: ServerConfig[]
  readyPath: string
  readyMethod?: 'GET' | 'POST'
  /** A function runs once the server is ready, for a request that needs something the server hands out. */
  request: RequestSpec | ((baseURL: string) => Promise<RequestSpec>)
  runtime?: 'node' | 'bun'
  /** Packages whose installed version is printed with the results. */
  versions?: string[]
}

interface Sample {
  reqPerSec: number
  latencyAvg: number
  latencyP50: number
  latencyP99: number
  throughputMBs: number
  failures: number
  totalRequests: number
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Cannot read ${name}: "${raw}" is not a non-negative integer`)
  }
  return value
}

const ROUNDS = Math.max(1, intEnv('BENCH_ROUNDS', 3))
const WARMUP = intEnv('BENCH_WARMUP', 5)
const DURATION = Math.max(1, intEnv('BENCH_DURATION', 10))
// The load generator, the harness and a single-threaded server share the machine, so the window of
// outstanding requests follows the cores rather than a fixed number: a window wide enough to queue measures
// the queue, and on a CPU-poor box it measures the collapse.
const CONNECTIONS = Math.max(8, intEnv('BENCH_CONNECTIONS', os.availableParallelism() * 8))
const PIPELINING = Math.max(1, intEnv('BENCH_PIPELINING', 8))
// The load generator runs off the harness thread and leaves a core for the server and one for the harness.
const WORKERS = Math.max(1, intEnv('BENCH_WORKERS', Math.min(4, os.availableParallelism() - 2)))
// Seconds a connection may go without a response before the load generator gives up on it.
const TIMEOUT = Math.max(1, intEnv('BENCH_TIMEOUT', 10))
// Autocannon gives up on a whole connection at once, costing one request per pipelining slot, so a starved
// connection is this many failures. More than that is the server rather than the machine.
const MAX_FAILURES = intEnv('BENCH_MAX_FAILURES', PIPELINING)
const READY_TIMEOUT = process.env.CI === 'true' ? 60_000 : 30_000

let activeChild: ChildProcess | null = null

function shutdown(): void {
  if (activeChild) {
    activeChild.kill('SIGKILL')
  }
  process.exit(1)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Cannot start the benchmark: port ${port} is in use. Stop the process holding it and run again`)
          : err,
      )
    })
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve()))
  })
}

interface Running {
  child: ChildProcess
  failure: () => Error | null
}

function start(server: ServerConfig, runtime: 'node' | 'bun'): Running {
  const child = spawn(server.cmd ?? process.execPath, server.args, {
    env: { ...process.env, NODE_ENV: 'production', ...server.env, PORT: String(server.port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  let failure: Error | null = null
  child.once('error', err => {
    failure = new Error(`Cannot start "${server.name}" on ${runtime}: ${err.message}`)
  })
  child.once('exit', (code, signal) => {
    failure ??= new Error(`Server "${server.name}" exited (code ${code}, signal ${signal}) while it was needed`)
  })

  return { child, failure: () => failure }
}

async function waitForReady(running: Running, url: string, method: 'GET' | 'POST'): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline) {
    const failure = running.failure()
    if (failure) {
      throw failure
    }
    try {
      const res = await fetch(url, { method })
      if (res.ok) {
        return
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Server at ${url} did not become ready within ${READY_TIMEOUT}ms`)
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function measure(server: ServerConfig, benchmark: LoadBenchmark): Promise<Sample> {
  await assertPortFree(server.port)

  const baseURL = `http://127.0.0.1:${server.port}`
  const running = start(server, benchmark.runtime ?? 'node')
  activeChild = running.child

  try {
    await waitForReady(running, baseURL + (server.readyPath ?? benchmark.readyPath), benchmark.readyMethod ?? 'GET')

    const spec = typeof benchmark.request === 'function' ? await benchmark.request(baseURL) : benchmark.request
    const options = {
      url: baseURL + (server.path ?? spec.path),
      method: spec.method ?? 'GET',
      headers: spec.headers,
      body: spec.body,
      connections: CONNECTIONS,
      pipelining: PIPELINING,
      workers: WORKERS,
      timeout: TIMEOUT,
    }

    if (WARMUP > 0) {
      await autocannon({ ...options, duration: WARMUP })
    }
    const result = await autocannon({ ...options, duration: DURATION })

    const failure = running.failure()
    if (failure) {
      throw failure
    }
    // A server that rejects every request answers faster than one that serves them, and would top the table.
    if (result.non2xx > 0) {
      throw new Error(`Cannot accept the "${server.name}" run: ${result.non2xx} non-2xx responses`)
    }
    // `errors` counts timeouts too.
    if (result.errors > MAX_FAILURES) {
      throw new Error(
        `Cannot accept the "${server.name}" run: ${result.errors} failed requests ` +
          `(${result.timeouts} timeouts), over the ${MAX_FAILURES} allowed`,
      )
    }

    return {
      reqPerSec: result.requests.average,
      latencyAvg: result.latency.average,
      latencyP50: result.latency.p50,
      latencyP99: result.latency.p99,
      throughputMBs: result.throughput.average / 1_048_576,
      failures: result.errors,
      totalRequests: result.requests.sent,
    }
  } finally {
    await stop(running.child)
    activeChild = null
    await new Promise(r => setTimeout(r, 500))
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

interface Row {
  name: string
  reqPerSec: number
  min: number
  max: number
  latencyAvg: number
  latencyP50: number
  latencyP99: number
  throughputMBs: number
  failures: number
  totalRequests: number
}

function summarize(name: string, samples: Sample[]): Row {
  const reqs = samples.map(s => s.reqPerSec)
  return {
    name,
    reqPerSec: median(reqs),
    min: Math.min(...reqs),
    max: Math.max(...reqs),
    latencyAvg: median(samples.map(s => s.latencyAvg)),
    latencyP50: median(samples.map(s => s.latencyP50)),
    latencyP99: median(samples.map(s => s.latencyP99)),
    throughputMBs: median(samples.map(s => s.throughputMBs)),
    failures: samples.reduce((total, s) => total + s.failures, 0),
    totalRequests: samples.reduce((total, s) => total + s.totalRequests, 0),
  }
}

const int = (n: number): string => Math.round(n).toLocaleString('en-US')

function printTable(rows: Row[]): void {
  const columns: Array<[string, (r: Row) => string]> = [
    ['Req/sec (median)', r => int(r.reqPerSec)],
    ['min', r => int(r.min)],
    ['max', r => int(r.max)],
    ['Lat avg (ms)', r => r.latencyAvg.toFixed(2)],
    ['p50 (ms)', r => r.latencyP50.toFixed(2)],
    ['p99 (ms)', r => r.latencyP99.toFixed(2)],
    ['MB/s', r => r.throughputMBs.toFixed(2)],
  ]

  const nameWidth = Math.max('Framework'.length, ...rows.map(r => r.name.length))
  const widths = columns.map(([title, cell]) => Math.max(title.length, ...rows.map(r => cell(r).length)))

  const header = ['Framework'.padEnd(nameWidth), ...columns.map(([title], i) => title.padStart(widths[i]!))]
  console.log(`\n${header.join(' | ')}`)
  console.log([nameWidth, ...widths].map(w => '-'.repeat(w)).join('-+-'))
  for (const r of rows) {
    console.log([r.name.padEnd(nameWidth), ...columns.map(([, cell], i) => cell(r).padStart(widths[i]!))].join(' | '))
  }
  console.log()
}

/**
 * Runs every server `BENCH_ROUNDS` times and reports the median round.
 *
 * Rounds are interleaved, and each one starts a server later in the list than the round before, so no server
 * always runs first, last, or right after the same neighbour.
 */
export async function runLoadBenchmark(benchmark: LoadBenchmark): Promise<void> {
  const { servers } = benchmark

  for (const server of servers) {
    if (server.builtPath) {
      try {
        await access(server.builtPath)
      } catch {
        throw new Error(
          `Compiled output not found at: ${server.builtPath}\nRun: npm run build -w @caffeinejs/benchmarks`,
        )
      }
    }
  }

  const samples = new Map<string, Sample[]>(servers.map(s => [s.name, []]))

  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < servers.length; i++) {
      const server = servers[(i + round) % servers.length]!
      if (process.env.CI !== 'true') {
        console.log(`[round ${round + 1}/${ROUNDS}] ${server.name}...`)
      }
      samples.get(server.name)!.push(await measure(server, benchmark))
    }
  }

  const rows = servers.map(s => summarize(s.name, samples.get(s.name)!)).sort((a, b) => b.reqPerSec - a.reqPerSec)

  printMachineInfo({ runtime: benchmark.runtime })
  printVersions(benchmark.versions ?? [])
  console.log(
    `\nLoad: ${ROUNDS} rounds, ${WARMUP}s warmup + ${DURATION}s measured, ${CONNECTIONS} connections, ` +
      `pipelining ${PIPELINING}, ${WORKERS} load workers, ${TIMEOUT}s timeout`,
  )
  printTable(rows)

  for (const row of rows.filter(r => r.failures > 0)) {
    console.log(`Tolerated failures: ${row.name} ${int(row.failures)} of ${int(row.totalRequests)} requests`)
  }
}
