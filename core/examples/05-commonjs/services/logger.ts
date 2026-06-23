import { Injectable } from '@caffeinejs/core/decorators'

@Injectable('logger')
export class Logger {
  info(message: string): void {
    console.log(`[INFO] ${message}`)
  }
}
