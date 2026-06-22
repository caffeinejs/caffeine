import { DiCaf, type Container } from '@caffeine/core'
import { CatsInMemoryRepository } from './cats/cats.repository.js'

export const CATS_REPOSITORY = Symbol.for('cats.repository')

export function createContainer(): Container {
  const di = new DiCaf()
  di.bind(CATS_REPOSITORY)
    .toClass(CatsInMemoryRepository)

  return di
}
