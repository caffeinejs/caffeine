import { Injectable } from '@caffeine/core/decorators'

@Injectable('logger')
export class Logger {
  info(message: string): void {
    console.log(`[INFO] ${message}`)
  }
}
