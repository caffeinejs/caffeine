import { Injectable } from '@nestjs/common'

@Injectable()
export class LoggerService {
  log(message: string): void {
    void message
  }
  error(message: string): void {
    void message
  }
  warn(message: string): void {
    void message
  }
}
