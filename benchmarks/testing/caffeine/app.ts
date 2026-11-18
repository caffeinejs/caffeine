import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http/node'

import { hello } from './hello.routes.js'

export function createContainer() {
  return new CaffeineIoC()
}

export function createApp(container: Container) {
  return createWebApplication({ adapter: node(), container }).mount(hello)
}
