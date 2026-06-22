import { provide, type Provider } from '@caffeine/core'
import { Injectable } from '@caffeine/core/decorators'
import { DataConfig } from '../util/gcs/data.config.js'
import { RequestContext } from '../util/request/request.context.js'
import type { Cat, CreateCatDTO, UpdateCatDTO } from './cat.js'
import { CatsCache } from './cats.cache.js'
import { CatsRepository } from './cats.repository.js'

@Injectable([CatsRepository, CatsCache, provide(RequestContext), provide(DataConfig)])
export class CatsService {
  constructor(
    private readonly repo: CatsRepository,
    private readonly cache: CatsCache,
    private readonly ctx: Provider<RequestContext>,
    private readonly dataConfig: Provider<DataConfig>,
  ) { }

  async findAll(): Promise<Cat[]> {
    return this.repo.findAll()
  }

  async findOne(id: number): Promise<Cat | undefined> {
    const config = this.dataConfig.get()
    const featureFlags = config.data['featureFlags']
    if (featureFlags !== undefined) {
      console.log(`[${this.ctx.get().correlationId}] featureFlags=${JSON.stringify(featureFlags)}`)
    }

    const cached = await this.cache.get(id)
    if (cached) {
      console.log(`[${this.ctx.get().correlationId}] cache hit id=${id}`)
      return cached
    }

    const cat = await this.repo.findOne(id)
    if (cat) {
      await this.cache.set(id, cat)
    }

    return cat
  }

  async create(dto: CreateCatDTO): Promise<Cat> {
    const cat = await this.repo.create(dto)

    await this.cache.set(cat.id, cat)

    return cat
  }

  async update(id: number, dto: UpdateCatDTO): Promise<Cat | undefined> {
    const cat = await this.repo.update(id, dto)
    if (cat) {
      await this.cache.set(id, cat)
    } else {
      await this.cache.del(id)
    }

    return cat
  }

  async remove(id: number): Promise<boolean> {
    const removed = await this.repo.remove(id)
    if (removed) {
      await this.cache.del(id)
    }

    return removed
  }
}
