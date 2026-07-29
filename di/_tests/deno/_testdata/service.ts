import { Injectable } from '@caffeinejs/di'

@Injectable()
export class DenoAutoloadService {
  greet(): string {
    return 'hello-from-deno-autoload'
  }
}
