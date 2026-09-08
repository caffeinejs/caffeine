import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bench, do_not_optimize, group, run } from 'mitata'

import { printMachineInfo } from '../machine-info.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type RunOnce = () => Promise<unknown>

async function loadRunOnce(builtPath: string): Promise<RunOnce> {
  try {
    await access(builtPath)
  } catch {
    throw new Error(`Compiled output not found at: ${builtPath}\nRun: npm run build -w @caffeinejs/benchmarks`)
  }

  const mod = (await import(pathToFileURL(builtPath).href)) as { runOnce: RunOnce }
  return mod.runOnce
}

const runCaffeine = await loadRunOnce(resolve(__dirname, '..', 'dist', 'testing', 'caffeine', 'run.js'))
const runNest = await loadRunOnce(resolve(__dirname, '..', 'dist', 'testing', 'nestjs', 'run.js'))

group('e2e request', () => {
  bench('caffeine', async () => {
    do_not_optimize(await runCaffeine())
  })
  bench('nestjs', async () => {
    do_not_optimize(await runNest())
  })
})

const { benchmarks } = await run({ colors: process.stdout.isTTY === true })

const fmtNs = (ns: number): string => {
  if (ns < 1_000) {
    return `${ns.toFixed(2)} ns`
  }
  if (ns < 1_000_000) {
    return `${(ns / 1_000).toFixed(2)} µs`
  }
  return `${(ns / 1_000_000).toFixed(2)} ms`
}

const entries = benchmarks
  .flatMap(t => t.runs)
  .filter(r => r.stats != null)
  .map(r => ({ name: r.name, avg: r.stats!.avg }))
  .sort((a, b) => a.avg - b.avg)

const maxName = Math.max(...entries.map(e => e.name.length))

printMachineInfo()

console.log('\n--- sorted fastest → slowest ---')
entries.forEach((e, i) => {
  const rank = String(i + 1).padStart(2)
  const name = e.name.padEnd(maxName)
  console.log(`${rank}. ${name}  ${fmtNs(e.avg)}`)
})
