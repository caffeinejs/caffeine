import { Authorize, Controller, Get, Schema } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { APIGroup, Operation } from '@caffeinejs/openapi'
import { PetsRepository } from '../pets/index.js'

// An open map rather than fixed keys: the response carries one entry per status that has pets, so the shape
// is "string → count" and additionalProperties is what describes it honestly.
const inventorySchema = $t.Record($t.String(), $t.Integer(), { $id: 'Inventory' })

// GET /inventories — a status → count map, derived from the pet table (prisma.pet.groupBy).
@APIGroup({ name: 'Inventory', description: 'Aggregate counts of pets by status.' })
@Controller('/inventories', [PetsRepository])
export class InventoryController {
  constructor(private readonly pets: PetsRepository) {}

  @Get('/')
  @Authorize()
  @Schema({ response: { 200: inventorySchema } })
  @Operation({ operationId: 'getInventory', summary: 'Count pets by status' })
  list() {
    return this.pets.countByStatus()
  }
}
