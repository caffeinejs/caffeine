import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'

import { hello } from './hello.routes.js'

export function createContainer() {
  return new CaffeineIoC()
}

export function createApp(container: Container) {
  return createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
    .build()
    .mount(hello)
}
