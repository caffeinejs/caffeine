import 'reflect-metadata'

import { run as runDI } from './startup/dist/di_app.js'
import { run as runDIScan } from './startup/dist/di_scan_app.js'
import { run as runNest } from './startup/dist/nest_app.js'
import { run as runInversify } from './_testdata/startup_legacy/dist/inversify_app.js'
import { run as runLoopback } from './_testdata/startup_legacy/dist/loopback_app.js'

// process-level wall-clock measurement (requires hyperfine):
// hyperfine \
//   'node _benchmarks/startup/dist/di_standalone.js' \
//   'node _benchmarks/startup/dist/nest_standalone.js' \
//   'node _benchmarks/_testdata/startup_legacy/dist/inversify_standalone.js' \
//   'node _benchmarks/_testdata/startup_legacy/dist/loopback_standalone.js' \
//   --warmup 3

const WARMUP = 5
const ITERATIONS = 50

async function measureAsync(fn: () => Promise<number>, warmup: number, n: number): Promise<number[]> {
  for (let i = 0; i < warmup; i++) { await fn() }
  const samples: number[] = []
  for (let i = 0; i < n; i++) { samples.push(await fn()) }
  return samples
}

function measureSync(fn: () => number, warmup: number, n: number): number[] {
  for (let i = 0; i < warmup; i++) { fn() }
  const samples: number[] = []
  for (let i = 0; i < n; i++) { samples.push(fn()) }
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

const row = (label: string, s: ReturnType<typeof stats>): string =>
  label.padEnd(12)
  + fmtMs(s.mean).padStart(COL)
  + fmtMs(s.min).padStart(COL)
  + fmtMs(s.max).padStart(COL)
  + fmtMs(s.p50).padStart(COL)
  + fmtMs(s.p95).padStart(COL)

console.log(`Warming up (${WARMUP} iterations each)...`)
const diSamples = await measureAsync(runDI, WARMUP, ITERATIONS)
const diScanSamples = await measureAsync(runDIScan, WARMUP, ITERATIONS)
const nestSamples = await measureAsync(runNest, WARMUP, ITERATIONS)
const inversifySamples = measureSync(runInversify, WARMUP, ITERATIONS)
const loopbackSamples = measureSync(runLoopback, WARMUP, ITERATIONS)

const results = [
  { name: 'di', s: stats(diSamples) },
  { name: 'di+scan', s: stats(diScanSamples) },
  { name: 'nestjs', s: stats(nestSamples) },
  { name: 'inversify', s: stats(inversifySamples) },
  { name: 'loopback', s: stats(loopbackSamples) },
].sort((a, b) => a.s.mean - b.s.mean)

const baseline = results[0]!.s.mean

console.log(`\n--- Startup Time (${ITERATIONS} iterations, same 7-class graph) ---\n`)
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
