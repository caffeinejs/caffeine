import { Container } from '@caffeinejs/core'

export interface Configurer {
  configure(container: Container): void
}
