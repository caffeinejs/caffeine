import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type RequestSpec, type ServerConfig } from '../load-harness.js'
import { buildFixture, FIXTURE, SCRIPT, STYLE } from './fixture.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath' | 'env'> => {
  const path = resolve(__dirname, '..', 'dist', 'static', dir, file)
  return { args: [path], builtPath: path, env: { STATIC_ROOT: FIXTURE } }
}

const servers: ServerConfig[] = [
  { name: 'caffeine', port: 3060, ...built('caffeine', 'caffeine.js') },
  { name: '@fastify/static', port: 3061, ...built('fastify-static', 'fastify-static.js') },
]

const versions = ['fastify', '@fastify/static', '@caffeinejs/http', '@caffeinejs/static']

/** Revalidates with the tag the server itself gave, so every measured request is a `304`. */
async function revalidation(baseURL: string): Promise<RequestSpec> {
  const headers = { 'accept-encoding': 'br' }
  const res = await fetch(baseURL + STYLE, { headers })
  const etag = res.headers.get('etag')

  if (!res.ok || etag === null) {
    throw new Error(`Cannot revalidate ${STYLE}: ${res.status}, etag ${etag}`)
  }

  return { path: STYLE, headers: { ...headers, 'if-none-match': etag }, expect: '3xx' }
}

await buildFixture()

console.log(`\n## A 2 KiB stylesheet, brotli\n`)
await runLoadBenchmark({
  servers,
  readyPath: '/health',
  request: { path: STYLE, headers: { 'accept-encoding': 'br' } },
  versions,
})

console.log(`\n## A 100 KiB script, identity\n`)
await runLoadBenchmark({ servers, readyPath: '/health', request: { path: SCRIPT }, versions })

console.log(`\n## A revalidation answered 304\n`)
await runLoadBenchmark({ servers, readyPath: '/health', request: revalidation, versions })
