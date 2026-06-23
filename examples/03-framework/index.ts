import { fileURLToPath } from 'node:url'
import fastify, { FastifyRequest } from 'fastify'
import { DiCaf, scan } from '@caffeinejs/core'
import { RouteParam } from './util/decorators/params.js'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

console.log('scanning')
await scan({ dir: rootDir, exclude: [import.meta.url] })
console.log('scanning done')

const server = fastify({ logger: true })

const container = new DiCaf()
container.assertResolvable()

await container.init()

const controllers = container.getBindingsByLabel(Symbol.for('controller'))

for (const controller of controllers) {
  const tags = controller.binding.tags
  const path = tags.get(Symbol.for('controller:base')) as string
  const routes = tags.get(Symbol.for('controller:routes')) as { handler: string, path: string, method: string }[]
  const routeParams = tags.get(Symbol.for('controller:params')) as Map<string, RouteParam[]>

  for (const route of routes) {
    const params = (routeParams.get(route.handler) || []) as RouteParam[]
    const pickers: ((request: FastifyRequest) => any)[] = []

    for (const param of params) {
      switch (param.type) {
        case 'path':
          pickers.push((request: FastifyRequest) => (request.params as Record<string, string>)[param.name])
          break
        case 'query':
          pickers.push((request: FastifyRequest) => (request.query as Record<string, string>)[param.name])
          break
        case 'body':
          pickers.push((request: FastifyRequest) => request.body)
          break
      }
    }

    server.route({
      method: route.method,
      url: route.path ? `${path}/${route.path}` : path,
      handler: function (this: unknown, request: FastifyRequest) {
        return (controller.binding.factory(controller.binding.ctx!) as any)[route.handler](
          ...pickers.map(picker => picker(request)),
        )
      },
    })
  }
}

await server.listen({ port: 3000, host: '0.0.0.0' })
