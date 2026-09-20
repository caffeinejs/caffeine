import { Authorize, Controller, Delete, ErrHTTPNotFound, Get, Post, Put, Schema, Status } from '@caffeinejs/http'
import { APIGroup, Operation } from '@caffeinejs/openapi'

import { APIErrorSchema } from '../util/errors/index.js'
import { UsersRepository } from './users.repository.js'
import type { CreateUserDTO, UpdateUserDTO } from './users.schemas.js'
import { CreateUserSchema, UpdateUserSchema, UserIdParamSchema, UserSchema } from './users.schemas.js'

@APIGroup({ name: 'Users', description: 'Register and manage user accounts.' })
@Controller('/users', [UsersRepository])
export class UsersController {
  constructor(private readonly users: UsersRepository) {}

  @Post('/', p => [p.body()])
  @Status(201)
  @Schema({
    body: CreateUserSchema,
    response: { 201: UserSchema, 422: APIErrorSchema },
  })
  @Operation({ operationId: 'createUser', summary: 'Register a user account' })
  create(dto: CreateUserDTO) {
    return this.users.create(dto)
  }

  @Get('/:id', p => [p.param('id')])
  @Authorize()
  @Schema({
    params: UserIdParamSchema,
    response: { 200: UserSchema, 404: APIErrorSchema },
  })
  @Operation({ operationId: 'getUserById', summary: 'Get a user by ID' })
  async get(id: string) {
    const user = await this.users.get(id)
    if (!user) {
      throw new ErrHTTPNotFound(`The requested user with ID "${id}" was not found`)
    }
    return user
  }

  @Put('/:id', p => [p.param('id'), p.body()])
  @Authorize()
  @Schema({
    params: UserIdParamSchema,
    body: UpdateUserSchema,
    response: { 200: UserSchema, 404: APIErrorSchema, 422: APIErrorSchema },
  })
  @Operation({ operationId: 'updateUser', summary: 'Update a user account' })
  async update(id: string, dto: UpdateUserDTO) {
    const user = await this.users.update(id, dto)
    if (!user) {
      throw new ErrHTTPNotFound(`The requested user with ID "${id}" was not found`)
    }
    return user
  }

  @Delete('/:id', p => [p.param('id')])
  @Status(204)
  @Authorize()
  @Schema({ params: UserIdParamSchema })
  @Operation({ operationId: 'deleteUser', summary: 'Delete a user account' })
  async remove(id: string) {
    await this.users.remove(id)
  }
}
