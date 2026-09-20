import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runLoadBenchmark, type ServerConfig } from '../load-harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT ?? '3000', 10)

const source = (dir: string, file: string): Pick<ServerConfig, 'args'> => ({ args: [resolve(__dirname, dir, file)] })

const built = (dir: string, file: string): Pick<ServerConfig, 'args' | 'builtPath'> => {
  const path = resolve(__dirname, '..', 'dist', 'helloworld', dir, file)
  return { args: [path], builtPath: path }
}

const servers: ServerConfig[] = [
  { name: 'fastify', port: PORT, ...source('fastify', 'fastify.js') },
  { name: 'express', port: PORT, ...source('express', 'express.js') },
  { name: 'nestjs', port: PORT, ...built('nestjs', 'nestjs.js') },
  { name: 'elysia', port: PORT, ...source('elysia', 'elysia.js') },
  { name: 'hono', port: PORT, ...source('hono', 'hono.js') },
  { name: 'node:http', port: PORT, ...source('node-http', 'node-http.js') },
  { name: 'adonisjs', port: PORT, ...source('adonisjs', 'adonisjs.js') },
  { name: 'trpc', port: PORT, path: '/hello', readyPath: '/hello', ...source('trpc', 'trpc.js') },
  { name: 'caffeine', port: PORT, ...built('caffeine', 'caffeine.js') },
  // The same route declared programmatically. Paired with the one above it is the only honest read on what the
  // fluent router costs: everything else about the two processes is identical.
  { name: 'caffeine-router', port: PORT, ...built('caffeine-router', 'caffeine-router.js') },
]

await runLoadBenchmark({
  servers,
  readyPath: '/',
  request: { path: '/' },
  versions: [
    'fastify',
    'express',
    '@nestjs/core',
    'elysia',
    'hono',
    '@adonisjs/http-server',
    '@trpc/server',
    '@caffeinejs/http',
  ],
})
