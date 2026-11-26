import { Container } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'

export function createApp(container: Container) {
  return createWebApplication({ adapter: node(), container })
}
