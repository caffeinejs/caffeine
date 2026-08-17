import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WARMUP = 5
const ITERATIONS = 50

function parseTimeEnd(output: string): number | null {
  const ms = output.match(/^start: ([\d.]+)ms$/m)
  if (ms) {
    return parseFloat(ms[1]!)
  }
  const s = output.match(/^start: ([\d.]+)s$/m)
  if (s) {
    return parseFloat(s[1]!) * 1000
  }
  return null
}

function measure(script: string): Promise<number> {
  return new Promise((res, rej) => {
    let out = ''
    const proc = spawn('node', [script], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    proc.on('close', () => {
      const ms = parseTimeEnd(out)
      if (ms !== null) {
        res(ms)
      } else {
        rej(new Error(`No timing in output of ${script}: ${out}`))
      }
    })
    proc.on('error', rej)
  })
}

async function measureN(script: string, warmup: number, n: number): Promise<number[]> {
  for (let i = 0; i < warmup; i++) {
    await measure(script)
  }
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    samples.push(await measure(script))
  }
  return samples
}

function stats(samples: number[]): { mean: number, min: number, max: number, p50: number, p95: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  return { mean, min: sorted[0]!, max: sorted[sorted.length - 1]!, p50, p95 }
}

const fmtMs = (ms: number): string => ms.toFixed(2) + ' ms'
const COL = 10

function row(label: string, s: ReturnType<typeof stats>): string {
  return label.padEnd(12)
    + fmtMs(s.mean).padStart(COL)
    + fmtMs(s.min).padStart(COL)
    + fmtMs(s.max).padStart(COL)
    + fmtMs(s.p50).padStart(COL)
    + fmtMs(s.p95).padStart(COL)
}

const dist = resolve(__dirname, 'dist')

console.log(`Warming up (${WARMUP} iterations each)...`)

const nestSamples = await measureN(resolve(dist, 'nestjs/app.js'), WARMUP, ITERATIONS)
const caffeineSamples = await measureN(resolve(dist, 'caffeine/app.js'), WARMUP, ITERATIONS)
const fastifySamples = await measureN(resolve(dist, 'fastify/app.js'), WARMUP, ITERATIONS)
const honoSamples = await measureN(resolve(dist, 'hono/app.js'), WARMUP, ITERATIONS)

const results = [
  { name: 'nestjs', s: stats(nestSamples) },
  { name: 'caffeine', s: stats(caffeineSamples) },
  { name: 'fastify', s: stats(fastifySamples) },
  { name: 'hono', s: stats(honoSamples) },
].sort((a, b) => a.s.mean - b.s.mean)

const baseline = results[0]!.s.mean

printMachineInfo()
console.log(`\n--- Startup Time (${ITERATIONS} iterations) ---\n`)
console.log(
  ''.padEnd(12)
  + 'mean'.padStart(COL)
  + 'min'.padStart(COL)
  + 'max'.padStart(COL)
  + 'p50'.padStart(COL)
  + 'p95'.padStart(COL)
  + '  vs fastest',
)
for (const { name, s } of results) {
  const ratio = s.mean / baseline
  const vs = ratio === 1 ? ' (baseline)' : `  ${ratio.toFixed(1)}x slower`
  console.log(row(name, s) + vs)
}
