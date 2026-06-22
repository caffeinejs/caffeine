import { describe, it } from 'vitest'
import { Get } from './decorators/verbs.js'
import { Controller } from './decorators/controller.js'

describe('HttpAdapter', () => {
  it('should be defined', () => {
    @Controller('/test')
    class TestController {
      @Get('/')
      async get() {
        return { ok: true }
      }
    }

    void new TestController()
  })
})
