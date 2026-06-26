import { Injectable } from '@caffeinejs/core'

@Injectable()
export class DenoAutoloadService {
  greet(): string {
    return 'hello-from-deno-autoload'
  }
}
