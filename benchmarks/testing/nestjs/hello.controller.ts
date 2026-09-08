import { Controller, Get } from '@nestjs/common'

import { HelloService } from './hello.service.js'

@Controller('hello')
export class HelloController {
  constructor(private readonly hello: HelloService) {}

  @Get()
  greet() {
    return this.hello.greet()
  }
}
