import type { DataSource, EntityTarget, ObjectLiteral, Repository } from 'typeorm'

export interface FakeRepository {
  readonly target: unknown
  readonly source: string
}

/**
 * A DataSource stand-in that records its lifecycle, so a test can see which connection produced a repository
 * and whether teardown ran.
 */
export class FakeDataSource {
  readonly handed: FakeRepository[] = []

  initialized = 0
  destroyed = 0

  readonly #name: string
  readonly #destroyDelayMs: number
  readonly #repositories = new Map<unknown, FakeRepository>()

  constructor(name = 'fake', destroyDelayMs = 0) {
    this.#name = name
    this.#destroyDelayMs = destroyDelayMs
  }

  get isInitialized(): boolean {
    return this.initialized > this.destroyed
  }

  async initialize(): Promise<this> {
    this.initialized += 1

    return this
  }

  async destroy(): Promise<void> {
    if (this.#destroyDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.#destroyDelayMs))
    }

    this.destroyed += 1
  }

  getRepository<E extends ObjectLiteral>(target: EntityTarget<E>): Repository<E> {
    let repository = this.#repositories.get(target)

    if (repository === undefined) {
      repository = { target, source: this.#name }
      this.#repositories.set(target, repository)
    }

    this.handed.push(repository)

    return repository as unknown as Repository<E>
  }

  asDataSource(): DataSource {
    return this as unknown as DataSource
  }
}
