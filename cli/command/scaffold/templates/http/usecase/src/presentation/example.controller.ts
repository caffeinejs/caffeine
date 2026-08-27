import { Controller, Get, Args, Post, $p } from '@caffeinejs/http'
import { CreateExampleUseCase } from '../application/usecases/create-example.usecase.js'
import { ListExamplesUseCase } from '../application/usecases/list-examples.usecase.js'

@Controller('/examples')
export class ExampleController {
  constructor(
    private readonly list: ListExamplesUseCase,
    private readonly create: CreateExampleUseCase,
  ) {}

  @Get('/')
  getAll() {
    return this.list.execute()
  }

  @Post('/')
  @Args([$p.body()])
  createOne(input: { name: string }) {
    return this.create.execute(input.name)
  }
}
