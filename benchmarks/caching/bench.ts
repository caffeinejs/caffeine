import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'caching', dir, file)
  return { args: [path], builtPath: path }
}

// The same built fixture twice per framework: once with its cache, once without (`BENCH_CACHE=off`). The
// harness repeats one identical request, so after the warmup every measured request on a cached row is a hit.
const servers: ServerConfig[] = [
  { name: 'caffeine', port: 3050, ...built('caffeine', 'caffeine.js') },
  { name: 'caffeine (no cache)', port: 3051, env: { BENCH_CACHE: 'off' }, ...built('caffeine', 'caffeine.js') },
  { name: 'nestjs', port: 3052, ...built('nestjs', 'nestjs.js') },
  { name: 'nestjs (no cache)', port: 3053, env: { BENCH_CACHE: 'off' }, ...built('nestjs', 'nestjs.js') },
]

await runLoadBenchmark({
  servers,
  readyPath: '/health',
  request: { path: '/api/products' },
  versions: ['@nestjs/core', '@nestjs/cache-manager', 'cache-manager', '@caffeinejs/http', '@caffeinejs/caching'],
})
