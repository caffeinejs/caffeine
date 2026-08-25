import { AllowAnonymous, Controller, Delete, ErrHTTPNotFound, Get, Params, Post, Put, Query, Roles, Schema, Status, $p } from '@caffeinejs/http'
import { APIGroup, Operation } from '@caffeinejs/openapi'
import { apiErrorSchema } from '../../util/errors/index.js'
import type { CreatePetDTO, PetFilters, PetSearchCriteria, UpdatePetDTO } from './pet.js'
import {
  createPetSchema,
  listPetsQuerySchema,
  petIdParamSchema,
  petListSchema,
  petPhotoSchema,
  petSchema,
  updatePetSchema,
} from './pet.js'
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

@APIGroup({ name: 'Pets', description: 'Browse, adopt and manage pets.' })
@Controller('/pets', [PetsRepository])
export class PetsController {
  constructor(private readonly pets: PetsRepository) {}

  // Public read — no controller-level guard, so unguarded routes are open.
  @Get('/')
  @AllowAnonymous()
  @Schema({ querystring: listPetsQuerySchema, response: { 200: petListSchema } })
  @Params([$p.query()])
  @Operation({ operationId: 'listPets', summary: 'List pets matching the given filters' })
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
  // fastify.addHttpMethod('QUERY', …) in src/app.ts before routing, and .version('3.2.0') on the OpenAPI
  // builder: a 3.1 path item has no field for a non-standard method, so a 3.1 document would omit this route.
  @Query('/')
  @AllowAnonymous()
  @Schema({ response: { 200: petListSchema } })
  @Params([$p.body()])
  @Operation({ operationId: 'searchPets', summary: 'Search pets by structured criteria' })
  search(body: PetSearchCriteria) {
    return this.pets.search(body ?? {})
  }

  @Get('/:id')
  @AllowAnonymous()
  @Schema({ params: petIdParamSchema, response: { 200: petSchema, 404: apiErrorSchema } })
  @Params([$p.param('id')])
  @Operation({
    operationId: 'getPet',
    summary: 'Get a pet by ID',
    responses: { 404: { description: 'No pet exists with that ID' } },
  })
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
  @Schema({ body: createPetSchema, response: { 201: petSchema, 422: apiErrorSchema } })
  @Params([$p.body()])
  @Operation({ operationId: 'createPet', summary: 'Add a pet to the store' })
  create(dto: CreatePetDTO) {
    return this.pets.create(dto)
  }

  @Put('/:id')
  @Roles('write:pets')
  @Schema({
    params: petIdParamSchema,
    body: updatePetSchema,
    response: { 200: petSchema, 404: apiErrorSchema, 422: apiErrorSchema },
  })
  @Params([$p.param('id'), $p.body()])
  @Operation({ operationId: 'updatePet', summary: 'Update an existing pet' })
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
  @Schema({ params: petIdParamSchema })
  @Params([$p.param('id')])
  @Operation({ operationId: 'deletePet', summary: 'Remove a pet from the store' })
  async remove(id: string) {
    await this.pets.remove(id)
  }

  // Multipart upload — $p.file() yields a Web API File for the `file` field, and is also what tells the
  // OpenAPI generator this route consumes multipart/form-data with a binary `file` part. Nothing restates it.
  @Post('/:id/images')
  @Status(201)
  @Roles('write:pets')
  @Schema({ params: petIdParamSchema, response: { 201: petPhotoSchema, 404: apiErrorSchema } })
  @Params([$p.param('id'), $p.file('file')])
  @Operation({ operationId: 'uploadPetPhoto', summary: 'Upload a photo for a pet' })
  async uploadImage(id: string, file: File) {
    const url = `https://cdn.petstoreapi.com/pets/${id}/${file.name}`
    const pet = await this.pets.addPhoto(id, url)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return { message: 'Image uploaded', success: true, photo: url }
  }
}
