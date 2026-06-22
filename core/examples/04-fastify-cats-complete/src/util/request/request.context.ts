import { Scopes } from '@caffeine/core'
import { Injectable, Lifetime, PostConstruct } from '@caffeine/core/decorators'

@Injectable()
@Lifetime(Scopes.REQUEST)
export class RequestContext {
  readonly correlationId = crypto.randomUUID()

  @PostConstruct()
  onCreated(): void {
    console.log(`[${this.correlationId}] request started`)
  }
}
