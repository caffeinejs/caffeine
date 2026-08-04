import { Controller, Delete, ErrNotFound, Get, Params, Post, Put, Schema, Status, $p } from '@caffeinejs/http'
import type { CreateUserDTO, UpdateUserDTO } from './user.js'
import { createUserSchema, updateUserSchema, userIdParamSchema } from './user.js'
import { UsersRepository } from './users.repository.js'

@Controller('/users', [UsersRepository])
export class UsersController {
  constructor(private readonly users: UsersRepository) {}

  @Post('/')
  @Status(201)
  @Schema({ body: createUserSchema })
  @Params([$p.body()])
  create(dto: CreateUserDTO) {
    return this.users.create(dto)
  }

  @Get('/:id')
  @Schema({ params: userIdParamSchema })
  @Params([$p.param('id')])
  async get(id: string) {
    const user = await this.users.get(id)
    if (!user) {
      throw new ErrNotFound(`The requested user with ID "${id}" was not found`)
    }
    return user
  }

  @Put('/:id')
  @Schema({ params: userIdParamSchema, body: updateUserSchema })
  @Params([$p.param('id'), $p.body()])
  async update(id: string, dto: UpdateUserDTO) {
    const user = await this.users.update(id, dto)
    if (!user) {
      throw new ErrNotFound(`The requested user with ID "${id}" was not found`)
    }
    return user
  }

  @Delete('/:id')
  @Status(204)
  @Schema({ params: userIdParamSchema })
  @Params([$p.param('id')])
  async remove(id: string) {
    await this.users.remove(id)
  }
}
