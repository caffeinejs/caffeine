import { fileURLToPath } from 'node:url'

import { CaffeineIoC } from '@caffeinejs/di'
import { scan } from '@caffeinejs/scan'

import { healthModule } from './health/health.mod.js'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// Decorated components must be loaded at least once for the decorators to be evaluated.
// This is done by the `scan` function.
// If the root dir is the current directory,
// the exclude option must include the current file and the application entrypoint.
await scan({
  dir: rootDir,
  exclude: [import.meta.url, new URL('./index.ts', import.meta.url)],
})

export async function createContainer(): Promise<CaffeineIoC> {
  // The health components are configured "manually" using a Module function.
  // All the other decorated components are automatically registered once the `scan` loads them once.
  // Both concepts can be mixed.
  return new CaffeineIoC({ modules: [healthModule] })
}
