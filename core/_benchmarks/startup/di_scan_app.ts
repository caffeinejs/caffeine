import { fileURLToPath } from 'node:url'
import { DiCaf } from '@caffeine/core'
import { scan } from '@caffeine/core'

const distDir = fileURLToPath(new URL('.', import.meta.url))

export async function run(): Promise<number> {
  const start = performance.now()
  await scan({ dir: distDir, matchFilter: '/scan_types' })
  const di = new DiCaf()
  await di.init()
  return performance.now() - start
}
