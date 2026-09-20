import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'request', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'fastify', port: 3020, ...built('fastify', 'fastify.js') },
  { name: 'hono', port: 3021, ...built('hono', 'hono.js') },
  { name: 'nestjs (fastify)', port: 3022, ...built('nestjs', 'nestjs.js') },
  { name: 'nestjs (express)', port: 3028, ...built('nestjs-express', 'nestjs.js') },
  { name: 'express', port: 3027, ...built('express', 'express.js') },
  { name: 'caffeine', port: 3023, ...built('caffeine', 'caffeine.js') },
  { name: 'caffeine-request-scope', port: 3025, ...built('caffeine-request-scope', 'caffeine.js') },
  { name: 'caffeine-middleware', port: 3026, ...built('caffeine-middleware', 'caffeine.js') },
  { name: 'elysia', port: 3024, ...built('elysia', 'elysia.js') },
]

await runLoadBenchmark({
  servers,
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
  versions: ['fastify', 'hono', '@nestjs/core', 'express', 'elysia', '@caffeinejs/http'],
})
