import { Authorize, Controller, Delete, ErrHTTPNotFound, Get, Post, Put, Schema, Status } from '@caffeinejs/http'
import { APIGroup, Operation } from '@caffeinejs/openapi'

import { apiErrorSchema } from '../../util/errors/index.js'
import type { CreateUserDTO, UpdateUserDTO } from './user.js'
import { createUserSchema, updateUserSchema, userIdParamSchema, userSchema } from './user.js'
import { UsersRepository } from './users.repository.js'

@APIGroup({ name: 'Users', description: 'Register and manage user accounts.' })
@Controller('/users', [UsersRepository])
export class UsersController {
  constructor(private readonly users: UsersRepository) {}

  @Post('/', p => [p.body()])
  @Status(201)
  @Schema({
    body: createUserSchema,
    response: { 201: userSchema, 422: apiErrorSchema },
  })
  @Operation({ operationId: 'createUser', summary: 'Register a user account' })
  create(dto: CreateUserDTO) {
    return this.users.create(dto)
  }

  @Get('/:id', p => [p.param('id')])
  @Authorize()
  @Schema({
    params: userIdParamSchema,
    response: { 200: userSchema, 404: apiErrorSchema },
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
    params: userIdParamSchema,
    body: updateUserSchema,
    response: { 200: userSchema, 404: apiErrorSchema, 422: apiErrorSchema },
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
  @Schema({ params: userIdParamSchema })
  @Operation({ operationId: 'deleteUser', summary: 'Delete a user account' })
  async remove(id: string) {
    await this.users.remove(id)
  }
}
