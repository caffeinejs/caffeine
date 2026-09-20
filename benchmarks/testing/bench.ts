import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bench, do_not_optimize, group, run, summary } from 'mitata'

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
  summary(() => {
    bench('caffeine', async () => {
      do_not_optimize(await runCaffeine())
    })
    bench('nestjs', async () => {
      do_not_optimize(await runNest())
    })
  })
})

await run({ colors: process.stdout.isTTY === true })

printMachineInfo()
