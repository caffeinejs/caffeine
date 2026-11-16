import { Container } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http/node'

export function createApp(container: Container) {
  return createWebApplication({ container }).server(() => ({ router: { ignoreTrailingSlash: true } }))
}
