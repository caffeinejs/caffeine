import { AllowAnonymous, Controller, Delete, ErrHTTPNotFound, Get, Params, Post, Put, Query, Roles, Schema, Status, $p } from '@caffeinejs/http'
import type { CreatePetDTO, PetFilters, PetSearchCriteria, UpdatePetDTO } from './pet.js'
import { createPetSchema, listPetsQuerySchema, petIdParamSchema, updatePetSchema } from './pet.js'
import { PetsRepository } from './pets.repository.js'

// Raw query values arrive as strings; @Schema coercion (integer/boolean) is applied by Fastify.
interface PetQuery {
  species?: PetFilters['species']
  status?: PetFilters['status']
  size?: PetFilters['size']
  ageMin?: number
  ageMax?: number
  goodWithKids?: boolean
  page?: number
  limit?: number
}

@Controller('/pets', [PetsRepository])
export class PetsController {
  constructor(private readonly pets: PetsRepository) {}

  // Public read — no controller-level guard, so unguarded routes are open.
  @Get('/')
  @AllowAnonymous()
  @Schema({ querystring: listPetsQuerySchema })
  @Params([$p.query()])
  list(query: PetQuery) {
    return this.pets.list({
      species: query.species,
      status: query.status,
      size: query.size,
      ageMin: query.ageMin,
      ageMax: query.ageMax,
      goodWithKids: query.goodWithKids,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    })
  }

  // OpenAPI 3.2 QUERY verb on /pets — structured search criteria in the body. Requires
  // fastify.addHttpMethod('QUERY', …) in src/main.ts before routing.
  @Query('/')
  @AllowAnonymous()
  @Params([$p.body()])
  search(body: PetSearchCriteria) {
    return this.pets.search(body ?? {})
  }

  @Get('/:id')
  @AllowAnonymous()
  @Params([$p.param('id')])
  async get(id: string) {
    const pet = await this.pets.get(id)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return pet
  }

  @Post('/')
  @Status(201)
  @Roles('write:pets')
  @Schema({ body: createPetSchema })
  @Params([$p.body()])
  create(dto: CreatePetDTO) {
    return this.pets.create(dto)
  }

  @Put('/:id')
  @Roles('write:pets')
  @Schema({ params: petIdParamSchema, body: updatePetSchema })
  @Params([$p.param('id'), $p.body()])
  async update(id: string, dto: UpdatePetDTO) {
    const pet = await this.pets.update(id, dto)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return pet
  }

  @Delete('/:id')
  @Status(204)
  @Roles('write:pets')
  @Params([$p.param('id')])
  async remove(id: string) {
    await this.pets.remove(id)
  }

  // Multipart upload — $p.file() yields a Web API File for the `file` field.
  @Post('/:id/images')
  @Status(201)
  @Roles('write:pets')
  @Params([$p.param('id'), $p.file('file')])
  async uploadImage(id: string, file: File) {
    const url = `https://cdn.petstoreapi.com/pets/${id}/${file.name}`
    const pet = await this.pets.addPhoto(id, url)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return { message: 'Image uploaded', success: true, photo: url }
  }
}
