import { Injectable } from '@caffeine-projects/dicaf/decorators'

@Injectable()
export class DenoAutoloadService {
  greet(): string {
    return 'hello-from-deno-autoload'
  }
}
