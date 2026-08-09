import { Controller, Delete, Get, Params, Post, Put, Status, $p, ErrHTTPNotFound, Context } from '@caffeinejs/http'
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
  @Params([$p.param('id')])
  findOne(id: string) {
    const cat = this.cats.findOne(Number(id))
    if (!cat) {
      throw new ErrHTTPNotFound()
    }

    return cat
  }

  @Post('/')
  @Status(201)
  @Params([$p.context(), $p.body()])
  create(ctx: Context, dto: CreateCatDTO) {
    const cat = this.cats.create(dto)
    ctx.header('Location', `/cats/${cat.id}`)

    return cat
  }

  @Put('/:id')
  @Params([$p.param('id'), $p.body()])
  update(id: string, dto: UpdateCatDTO) {
    const cat = this.cats.update(Number(id), dto)
    if (!cat) {
      throw new ErrHTTPNotFound()
    }

    return cat
  }

  @Delete('/:id')
  @Params([$p.param('id')])
  remove(id: string) {
    this.cats.remove(Number(id))
  }
}
