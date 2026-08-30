import { CaffeineIoC, type Container, token } from '@caffeinejs/di'
import { CatsInMemoryRepository, type CatsRepository } from './cats/cats.repository.js'

export const CATS_REPOSITORY = token<CatsRepository>(Symbol.for('cats.repository'))

export function createContainer(): Container {
  const di = new CaffeineIoC()
  di.bind(CATS_REPOSITORY)
    .toClass(CatsInMemoryRepository)

  return di
}
