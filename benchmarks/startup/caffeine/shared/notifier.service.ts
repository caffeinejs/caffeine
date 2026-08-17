import { Injectable } from '@caffeinejs/di'
import { LoggerService } from './logger.service.js'

@Injectable([LoggerService])
export class NotifierService {
  constructor(private readonly logger: LoggerService) {}

  notify(event: string, payload: unknown): void {
    this.logger.log(`[notify] ${event}`)
    void payload
  }
}
