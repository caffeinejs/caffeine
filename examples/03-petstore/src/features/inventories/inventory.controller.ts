import { Authorize, Controller, Get } from '@caffeinejs/http'
import { PetsRepository } from '../pets/index.js'

// GET /inventories — a status → count map, derived from the pet table (prisma.pet.groupBy).
@Controller('/inventories', [PetsRepository])
export class InventoryController {
  constructor(private readonly pets: PetsRepository) {}

  @Get('/')
  @Authorize()
  list() {
    return this.pets.countByStatus()
  }
}
