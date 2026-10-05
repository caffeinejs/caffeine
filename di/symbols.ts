import { token } from './key.js'
import type { Refresher } from './refresher.js'
import type { RequestScopeManager } from './request_scope_manager.js'

/** Placeholder consumer for {@link Container.resolver} — never constructed. */
interface StandaloneResolverConsumer {
  readonly __caffeineStandaloneResolver: never
}

export const Keys = {
  kRefresher: token<Refresher>(Symbol.for('@caffeinejs/di:refresher')),
  kRequestScopeManager: token<RequestScopeManager>(Symbol.for('@caffeinejs/di:request-scope-manager')),
  kStandaloneResolver: token<StandaloneResolverConsumer>(Symbol.for('@caffeinejs/di:standalone')),
  kMetadata: Symbol.for('@caffeinejs/di:metadata'),
}
