import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'mixedscopes', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'caffeine', port: 3030, ...built('caffeine', 'caffeine.js') },
  { name: 'nestjs', port: 3031, ...built('nestjs', 'nestjs.js') },
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
  versions: ['@nestjs/core', '@caffeinejs/http', '@caffeinejs/di'],
})
