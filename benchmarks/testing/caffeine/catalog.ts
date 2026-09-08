import { Injectable } from '@caffeinejs/di'

import { Cache, IdGenerator, Logger } from './infra.js'

@Injectable([Cache, IdGenerator])
export class CatalogRepository {
  constructor(
    private readonly cache: Cache,
    private readonly ids: IdGenerator,
  ) {}

  find(): string {
    return this.cache.get('greeting') ?? String(this.ids.next())
  }
}

@Injectable([Cache, Logger])
export class InventoryRepository {
  constructor(
    private readonly cache: Cache,
    private readonly logger: Logger,
  ) {}

  stock(): number {
    this.logger.log('stock')
    return this.cache.get('greeting') === undefined ? 0 : 1
  }
}

@Injectable([CatalogRepository, InventoryRepository, Cache])
export class PricingService {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly inventory: InventoryRepository,
    private readonly cache: Cache,
  ) {}

  quote(): number {
    void this.catalog.find()
    void this.inventory.stock()
    void this.cache.get('greeting')
    return 0
  }
}
