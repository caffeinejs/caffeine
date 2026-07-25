import { Scopes, Injectable, Lifetime, PostConstruct } from '@caffeinejs/core'

@Injectable()
@Lifetime(Scopes.REQUEST)
export class RequestContext {
  readonly correlationID = crypto.randomUUID()

  @PostConstruct()
  onCreated(): void {
    console.log(`[${this.correlationID}] request started`)
  }
}
