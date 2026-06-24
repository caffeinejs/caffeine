import { fileURLToPath } from 'node:url'
import { CaffeineIoC, scan } from '@caffeinejs/core'

const distDir = fileURLToPath(new URL('.', import.meta.url))

export async function run(): Promise<number> {
  const start = performance.now()
  await scan({ dir: distDir, matchFilter: '/scan_types' })
  const di = new CaffeineIoC()
  await di.init()
  return performance.now() - start
}
