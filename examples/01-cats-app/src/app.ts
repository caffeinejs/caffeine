import { Container } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'

export function createApp(container: Container) {
  return createWebApplication({ container }).server(() => ({
    factory: { routerOptions: { ignoreTrailingSlash: true } },
  }))
}
