import { Controller, Delete, Get, Params, Post, Put, Status, body, param } from '@caffeinejs/http'
import type { CreateCatDTO, UpdateCatDTO } from './cat.js'
import { CatsService } from './cats.service.js'

@Controller('/cats', [CatsService])
export class CatsController {
  constructor(private readonly cats: CatsService) {}

  @Get('/')
  findAll() {
    return this.cats.findAll()
  }

  @Get('/:id')
  @Params([param('id')])
  findOne(id: string) {
    const cat = this.cats.findOne(Number(id))
    if (!cat) {
      return new Response(null, { status: 404 })
    }
    return cat
  }

  @Post('/')
  @Status(201)
  @Params([body()])
  create(dto: CreateCatDTO) {
    return this.cats.create(dto)
  }

  @Put('/:id')
  @Params([param('id'), body()])
  update(id: string, dto: UpdateCatDTO) {
    const cat = this.cats.update(Number(id), dto)
    if (!cat) {
      return new Response(null, { status: 404 })
    }
    return cat
  }

  @Delete('/:id')
  @Params([param('id')])
  remove(id: string) {
    this.cats.remove(Number(id))
    return new Response(null, { status: 204 })
  }
}
