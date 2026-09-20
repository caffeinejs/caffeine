import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'fastify', file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'fastify', port: 3030, ...built('bare.js') },
  { name: 'fastify-fetch', port: 3031, ...built('fetch.js') },
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
      text: 'hello',
      num: '42',
      bool: 'true',
    },
  },
  versions: ['fastify', '@fastify/fetch'],
})
