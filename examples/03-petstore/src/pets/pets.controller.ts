import {
  AllowAnonymous,
  Controller,
  Delete,
  ErrHTTPNotFound,
  Get,
  Post,
  Put,
  Query,
  Roles,
  Schema,
  Status,
} from '@caffeinejs/http'
import { $multipart } from '@caffeinejs/multipart'
import { APIGroup, Operation } from '@caffeinejs/openapi'

import { APIErrorSchema } from '../util/errors/index.js'
import { PetsRepository } from './pets.repository.js'
import type { CreatePetDTO, PetFilters, PetSearchCriteria, UpdatePetDTO } from './pets.schemas.js'
import {
  CreatePetSchema,
  ListPetsQuerySchema,
  PetIdParamSchema,
  PetListSchema,
  PetPhotoSchema,
  PetSchema,
  SearchPetsSchema,
  UpdatePetSchema,
} from './pets.schemas.js'

@APIGroup({ name: 'Pets', description: 'Browse, adopt and manage pets.' })
@Controller('/pets', [PetsRepository])
export class PetsController {
  constructor(private readonly pets: PetsRepository) {}

  // Public read — no controller-level guard, so unguarded routes are open.
  @Get('/', p => [p.query()])
  @AllowAnonymous()
  @Schema({
    querystring: ListPetsQuerySchema,
    response: { 200: PetListSchema },
  })
  @Operation({
    operationId: 'listPets',
    summary: 'List pets matching the given filters',
  })
  // Raw query values arrive as strings; Fastify coerces them to the types the schema declares, and `page` and
  // `limit` are filled from its defaults — so the filters reach the repository already complete.
  list(query: PetFilters) {
    return this.pets.list(query)
  }

  // OpenAPI 3.2's QUERY verb on /pets — a safe, idempotent read whose criteria are too structured for a
  // query string. Fastify carries QUERY in its default method set, so nothing is opted into here; documenting
  // it is what needs .version('3.2.0'), a 3.1 path item having no field for a method outside the fixed set.
  @Query('/', p => [p.body()])
  @AllowAnonymous()
  @Schema({ body: SearchPetsSchema, response: { 200: PetListSchema } })
  @Operation({
    operationId: 'searchPets',
    summary: 'Search pets by structured criteria',
  })
  search(body: PetSearchCriteria) {
    return this.pets.search(body ?? {})
  }

  @Get('/:id', p => [p.param('id')])
  @AllowAnonymous()
  @Schema({
    params: PetIdParamSchema,
    response: { 200: PetSchema, 404: APIErrorSchema },
  })
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

  @Post('/', p => [p.body()])
  @Status(201)
  @Roles('write:pets')
  @Schema({
    body: CreatePetSchema,
    response: { 201: PetSchema, 422: APIErrorSchema },
  })
  @Operation({ operationId: 'createPet', summary: 'Add a pet to the store' })
  create(dto: CreatePetDTO) {
    return this.pets.create(dto)
  }

  @Put('/:id', p => [p.param('id'), p.body()])
  @Roles('write:pets')
  @Schema({
    params: PetIdParamSchema,
    body: UpdatePetSchema,
    response: { 200: PetSchema, 404: APIErrorSchema, 422: APIErrorSchema },
  })
  @Operation({ operationId: 'updatePet', summary: 'Update an existing pet' })
  async update(id: string, dto: UpdatePetDTO) {
    const pet = await this.pets.update(id, dto)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return pet
  }

  @Delete('/:id', p => [p.param('id')])
  @Status(204)
  @Roles('write:pets')
  @Schema({ params: PetIdParamSchema })
  @Operation({
    operationId: 'deletePet',
    summary: 'Remove a pet from the store',
  })
  async remove(id: string) {
    await this.pets.remove(id)
  }

  // Multipart upload — $multipart.file() yields a Web API File for the `file` field, and is also what tells the
  // OpenAPI generator this route consumes multipart/form-data with a binary `file` part. Nothing restates it.
  @Post('/:id/images', p => [p.param('id'), $multipart.file('file')])
  @Status(201)
  @Roles('write:pets')
  @Schema({
    params: PetIdParamSchema,
    response: { 201: PetPhotoSchema, 404: APIErrorSchema },
  })
  @Operation({
    operationId: 'uploadPetPhoto',
    summary: 'Upload a photo for a pet',
  })
  async uploadImage(id: string, file: File) {
    const url = `https://cdn.petstoreapi.com/pets/${id}/${file.name}`
    const pet = await this.pets.addPhoto(id, url)
    if (!pet) {
      throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
    }
    return { message: 'Image uploaded', success: true, photo: url }
  }
}
