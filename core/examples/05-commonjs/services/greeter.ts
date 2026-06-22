import { Inject, Injectable } from '@caffeine/core/decorators'
import type { Logger } from './logger.js'

@Injectable('greeter')
export class Greeter {
  @Inject('logger')
  accessor logger!: Logger

  greet(name: string): string {
    const message = `Hello, ${name}!`
    this.logger.info(message)
    return message
  }
}
