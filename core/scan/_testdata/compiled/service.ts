import { Injectable } from '@caffeinejs/core/decorators'

@Injectable('compiled-svc')
export class CompiledService {
  greet(): string {
    return 'hello from compiled-svc'
  }
}
