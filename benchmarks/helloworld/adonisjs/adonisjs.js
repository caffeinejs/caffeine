import { createServer } from 'node:http'

import { Application } from '@adonisjs/application'
import { Encryption } from '@adonisjs/encryption'
import { Emitter } from '@adonisjs/events'
import { defineConfig, Server } from '@adonisjs/http-server'
import { Logger } from '@adonisjs/logger'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const app = new Application(new URL('./', import.meta.url), {
  environment: 'web',
  importer: () => {
    // noop
  },
})

await app.init()

const server = new Server(
  app,
  new Encryption({ secret: 'superlongandsupersecretthatisverylongandverysecret' }),
  new Emitter(app),
  new Logger({ enabled: false }),
  defineConfig({
    logger: {
      enabled: false,
    },
  }),
)

server.getRouter().get('/', ctx => {
  return ctx.response.send({ hello: 'world' })
})

await server.boot()

createServer(server.handle.bind(server)).listen(PORT, '0.0.0.0')
