import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'authn', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'caffeine', port: 3040, ...built('caffeine', 'caffeine.js') },
  { name: 'nestjs', port: 3041, ...built('nestjs', 'nestjs.js') },
]

async function mintToken(baseURL: string): Promise<string> {
  const res = await fetch(`${baseURL}/token`, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`POST /token returned ${res.status}`)
  }

  const body = (await res.json()) as { access_token?: string }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('POST /token did not return access_token')
  }

  return body.access_token
}

await runLoadBenchmark({
  servers,
  readyPath: '/token',
  readyMethod: 'POST',
  request: async baseURL => ({
    path: '/protected',
    headers: { authorization: `Bearer ${await mintToken(baseURL)}` },
  }),
  versions: ['@nestjs/core', '@nestjs/jwt', '@nestjs/passport', 'passport-jwt', '@caffeinejs/http'],
})
