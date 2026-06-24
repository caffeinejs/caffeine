import { Injectable } from '@caffeinejs/core/decorators'

@Injectable()
export class DenoAutoloadService {
  greet(): string {
    return 'hello-from-deno-autoload'
  }
}
