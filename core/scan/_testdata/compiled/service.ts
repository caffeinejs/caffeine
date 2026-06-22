import { Injectable } from '@caffeine/core/decorators'

@Injectable('compiled-svc')
export class CompiledService {
  greet(): string {
    return 'hello from compiled-svc'
  }
}
