import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WARMUP = 5
const ITERATIONS = 50
const TIMEOUT_MS = 15_000

interface Timing {
  /** Process start to listening: module loading, decorator evaluation and bootstrap. */
  start: number
  /** Bootstrap alone, from the first statement after the imports. */
  bootstrap: number
}

function parseTiming(output: string): Timing | null {
  const start = output.match(/^start: ([\d.]+)ms$/m)
  const bootstrap = output.match(/^bootstrap: ([\d.]+)ms$/m)
  if (!start || !bootstrap) {
    return null
  }
  return { start: parseFloat(start[1]!), bootstrap: parseFloat(bootstrap[1]!) }
}

function measure(script: string): Promise<Timing> {
  return new Promise((res, rej) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const proc = spawn(process.execPath, [script], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, TIMEOUT_MS)
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        rej(new Error(`Timed out after ${TIMEOUT_MS}ms: ${script}\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      const timing = parseTiming(stdout)
      if (timing !== null) {
        res(timing)
      } else {
        rej(
          new Error(
            `No timing in output of ${script} (exit ${code}${signal != null ? `/${signal}` : ''}):\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        )
      }
    })
    proc.on('error', err => {
      clearTimeout(timer)
      rej(err)
    })
  })
}

function stats(samples: number[]): { mean: number; min: number; max: number; p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  return { mean, min: sorted[0]!, max: sorted[sorted.length - 1]!, p50, p95 }
}

const fmtMs = (ms: number): string => ms.toFixed(2) + ' ms'
const COL = 12

function row(label: string, s: ReturnType<typeof stats>): string {
  return (
    label.padEnd(12) +
    fmtMs(s.mean).padStart(COL) +
    fmtMs(s.min).padStart(COL) +
    fmtMs(s.max).padStart(COL) +
    fmtMs(s.p50).padStart(COL) +
    fmtMs(s.p95).padStart(COL)
  )
}

const dist = resolve(__dirname, 'dist')

const apps = [
  { name: 'nestjs', script: resolve(dist, 'nestjs/app.js') },
  { name: 'caffeine', script: resolve(dist, 'caffeine/app.js') },
  { name: 'fastify', script: resolve(dist, 'fastify/app.js') },
  { name: 'hono', script: resolve(dist, 'hono/app.js') },
]

// One process of each application per round, and each round starts one application later than the last, so
// drift over the run lands on all of them alike instead of on whichever block ran last.
async function collect(rounds: number): Promise<Map<string, Timing[]>> {
  const samples = new Map<string, Timing[]>(apps.map(a => [a.name, []]))
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < apps.length; i++) {
      const app = apps[(i + round) % apps.length]!
      samples.get(app.name)!.push(await measure(app.script))
    }
  }
  return samples
}

console.log(`warming up (${WARMUP} rounds)...`)
await collect(WARMUP)
console.log(`measuring (${ITERATIONS} rounds)...`)
const samples = await collect(ITERATIONS)

function printTable(title: string, pick: (t: Timing) => number): void {
  const results = apps
    .map(a => ({ name: a.name, s: stats(samples.get(a.name)!.map(pick)) }))
    .sort((a, b) => a.s.p50 - b.s.p50)
  const baseline = results[0]!.s.p50

  console.log(`\n--- ${title} (${ITERATIONS} iterations) ---\n`)
  console.log(
    ''.padEnd(12) +
      'mean'.padStart(COL) +
      'min'.padStart(COL) +
      'max'.padStart(COL) +
      'p50'.padStart(COL) +
      'p95'.padStart(COL) +
      '  vs fastest (p50)',
  )
  for (const { name, s } of results) {
    const ratio = s.p50 / baseline
    const vs = ratio === 1 ? ' (baseline)' : `  ${ratio.toFixed(1)}x slower`
    console.log(row(name, s) + vs)
  }
}

printMachineInfo()
printTable('Startup: process start to listening', t => t.start)
printTable('Bootstrap only: after imports to listening', t => t.bootstrap)
