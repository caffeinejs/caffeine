import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWebApplication } from '@caffeinejs/http/fastify'
import { staticFiles } from '@caffeinejs/static'
import { buildStatic } from '@caffeinejs/static/build'
import { MiB } from '@caffeinejs/std/bytes'

import { printMachineInfo } from '../machine-info.js'

/**
 * `bootstrap()` of an application serving one mount of 100, 1,000 and 5,000 files, the way a build lays them out:
 * a few at the root, the rest in directories of a hundred. Reading the manifest, checking each file on disk and
 * registering the routes is what grows with the count.
 *
 * Each count runs in a process of its own, after one bootstrap of a one-file mount has loaded every module, so the
 * heap it reports is the mount's and not the framework's.
 */
const COUNTS = [100, 1_000, 5_000]
const ROUNDS = 7

const siteOf = (count: number) => join(tmpdir(), `caffeine-bench-static-startup-${count}`)

async function writeSite(count: number): Promise<void> {
  const root = siteOf(count)
  await rm(root, { recursive: true, force: true })

  for (let i = 0; i < count; i++) {
    const dir = i < 10 ? root : join(root, 'assets', `chunk-${Math.floor(i / 100)}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `file-${i}.js`), `export const value${i} = ${i}\n`)
  }

  await buildStatic({ root })
}

/** Bootstraps a mount of `root`; the heap it holds, measured while the application is up, and the time it took. */
async function bootstrap(root: string): Promise<{ time: number; heap: number }> {
  globalThis.gc!()
  const before = process.memoryUsage().heapUsed
  const started = performance.now()
  const app = createWebApplication({ logger: false }).with(staticFiles(s => s.serve(root, { anonymous: true })))
  await app.bootstrap()
  const time = performance.now() - started
  globalThis.gc!()
  const heap = process.memoryUsage().heapUsed - before
  await app.close()

  return { time, heap }
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!

const child = process.argv[2]

if (child !== undefined) {
  await bootstrap(siteOf(1))
  const first = await bootstrap(siteOf(Number(child)))
  const times = [first.time]

  for (let round = 1; round < ROUNDS; round++) {
    times.push((await bootstrap(siteOf(Number(child)))).time)
  }

  console.log(JSON.stringify({ time: median(times), heap: first.heap }))
} else {
  await writeSite(1)
  printMachineInfo({})
  console.log('\n| Files | bootstrap() median | Heap held by the mount |')
  console.log('| ----: | -----------------: | ---------------------: |')

  for (const count of COUNTS) {
    await writeSite(count)
    const output = execFileSync(
      process.execPath,
      ['--expose-gc', '--import=tsx', fileURLToPath(import.meta.url), String(count)],
      { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' },
    )
    const { time, heap } = JSON.parse(output.trim().split('\n').at(-1)!) as { time: number; heap: number }
    console.log(`| ${count.toLocaleString('en')} | ${time.toFixed(1)} ms | ${(heap / MiB).toFixed(1)} MiB |`)
    await rm(siteOf(count), { recursive: true, force: true })
  }

  await rm(siteOf(1), { recursive: true, force: true })
}
