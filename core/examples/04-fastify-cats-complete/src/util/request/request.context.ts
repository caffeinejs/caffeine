import { Scopes, Injectable, Lifetime, PostConstruct } from '@caffeinejs/core'

@Injectable()
@Lifetime(Scopes.REQUEST)
export class RequestContext {
  readonly correlationId = crypto.randomUUID()

  @PostConstruct()
  onCreated(): void {
    console.log(`[${this.correlationId}] request started`)
  }
}
