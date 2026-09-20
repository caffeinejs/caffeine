import { Router } from '@caffeinejs/http'
import { apiGroup, operation } from '@caffeinejs/openapi'

import { PetsRepository } from '../pets/index.js'
import { InventorySchema } from './inventories.schemas.js'

/**
 * One route, and no repository of its own: the counts are derived from the pet table, so this group injects
 * `PetsRepository` and the `pets` module provides it.
 */
export const inventoriesRouter = new Router('/inventories')
  .name('Inventory')
  .with(apiGroup({ name: 'Inventory', description: 'Aggregate counts of pets by status.' }))
  .inject({ pets: PetsRepository })
  .authorize({})
  .get('/')
  .schema({ response: { 200: InventorySchema } })
  .with(operation({ operationId: 'getInventory', summary: 'Count pets by status' }))
  .handler((_ctx, deps) => deps.pets.countByStatus())
