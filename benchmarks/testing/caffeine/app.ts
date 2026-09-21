import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'

import { hello } from './hello.routes.js'

export function createContainer() {
  return new CaffeineIoC()
}

export function createApp(container: Container) {
  return createWebApplication({ container }).mount(hello)
}
