import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(__dirname, 'dist')
const NODE = process.execPath
const N = 10

interface MemUsage {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

function sample(script: string): MemUsage {
  const result = spawnSync(NODE, ['--expose-gc', script], { encoding: 'utf8' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Worker exited with code ${result.status}:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout) as MemUsage
}

function collect(script: string, n: number): MemUsage[] {
  const samples: MemUsage[] = []
  for (let i = 0; i < n; i++) {
    samples.push(sample(script))
  }
  return samples
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function summarize(samples: MemUsage[]): Record<keyof MemUsage, number> {
  return {
    rss: median(samples.map(s => s.rss)),
    heapTotal: median(samples.map(s => s.heapTotal)),
    heapUsed: median(samples.map(s => s.heapUsed)),
    external: median(samples.map(s => s.external)),
    arrayBuffers: median(samples.map(s => s.arrayBuffers)),
  }
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(0) + ' KB'
}

const baselineSample = spawnSync(
  NODE,
  ['--expose-gc', '-e', 'global.gc();process.stdout.write(JSON.stringify(process.memoryUsage()))'],
  { encoding: 'utf8' },
)
const baseline = JSON.parse(baselineSample.stdout) as MemUsage

console.log(`Collecting ${N} samples each (subprocess per sample)...`)
const caffeineSamples = collect(`${DIST}/caffeine/memory.js`, N)
const nestSamples = collect(`${DIST}/nestjs/memory.js`, N)

const caffeine = summarize(caffeineSamples)
const nest = summarize(nestSamples)

const caffeineOverhead = caffeine.heapUsed - baseline.heapUsed
const nestOverhead = nest.heapUsed - baseline.heapUsed
const smallerOverhead = Math.min(caffeineOverhead, nestOverhead)

const COL = 12

function row(label: string, m: Record<keyof MemUsage, number>, overhead: number): string {
  const ratio = overhead / smallerOverhead
  const vs = ratio === 1 ? ' (baseline)' : `  ${ratio.toFixed(1)}x more`
  return (
    label.padEnd(10)
    + kb(m.heapUsed).padStart(COL)
    + kb(m.heapTotal).padStart(COL)
    + kb(m.rss).padStart(COL)
    + kb(m.external).padStart(COL)
    + kb(overhead).padStart(COL)
    + vs
  )
}

printMachineInfo()
console.log(`\n--- Memory Usage (median of ${N} subprocess runs, same 6-module app) ---\n`)
console.log(`Node.js baseline heapUsed: ${kb(baseline.heapUsed)}\n`)
console.log(
  ''.padEnd(10)
  + 'heapUsed'.padStart(COL)
  + 'heapTotal'.padStart(COL)
  + 'rss'.padStart(COL)
  + 'external'.padStart(COL)
  + 'overhead'.padStart(COL),
)
const rows = [
  { name: 'caffeine', m: caffeine, overhead: caffeineOverhead },
  { name: 'nestjs', m: nest, overhead: nestOverhead },
].sort((a, b) => a.overhead - b.overhead)

for (const { name, m, overhead } of rows) {
  console.log(row(name, m, overhead))
}
