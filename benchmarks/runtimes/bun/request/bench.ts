import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../../../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const benchmarksRoot = resolve(__dirname, '../../..')

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(benchmarksRoot, 'dist', 'request', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'fastify', cmd: 'bun', port: 3020, args: [resolve(benchmarksRoot, 'request', 'fastify', 'fastify.ts')] },
  { name: 'hono', cmd: 'bun', port: 3021, args: [resolve(__dirname, 'hono', 'hono.ts')] },
  { name: 'nestjs', cmd: 'bun', port: 3022, ...built('nestjs', 'nestjs.js') },
  { name: 'caffeine', cmd: 'bun', port: 3023, ...built('caffeine', 'caffeine.js') },
  { name: 'elysia', cmd: 'bun', port: 3024, args: [resolve(__dirname, 'elysia', 'elysia.ts')] },
]

try {
  execSync('bun --version', { stdio: 'ignore' })
} catch {
  throw new Error('Bun is not available on PATH — install from https://bun.sh')
}

await runLoadBenchmark({
  servers,
  runtime: 'bun',
  readyPath: '/health',
  request: {
    path: '/api/test/hello/42/true?text=world&num=7&bool=false',
    method: 'POST',
    body: JSON.stringify({ text: 'test', num: 99, bool: true }),
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'benchmark',
      text: 'hello',
      num: '42',
      bool: 'true',
    },
  },
  versions: ['fastify', 'hono', '@nestjs/core', 'elysia', '@caffeinejs/http'],
})
