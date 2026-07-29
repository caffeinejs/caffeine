import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { CatsInMemoryRepository } from './cats/cats.repository.js'

export const CATS_REPOSITORY = Symbol.for('cats.repository')

export function createContainer(): Container {
  const di = new CaffeineIoC()
  di.bind(CATS_REPOSITORY)
    .toClass(CatsInMemoryRepository)

  return di
}
