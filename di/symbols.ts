import { token } from './key.js'
import type { Refresher } from './refresher.js'
import type { RequestScopeManager } from './request_scope_manager.js'

/** Placeholder consumer for {@link Container.resolver} — never constructed. */
interface StandaloneResolverConsumer {
  readonly __caffeineStandaloneResolver: never
}

/**
 * Placeholder for the values provider. Its real shape is the application's configuration, which the container
 * cannot name — {@link Container.bindValuesProvider} re-types the key to the caller's `T`.
 */
interface ValuesProvider {
  readonly __caffeineValuesProvider: never
}

export const Keys = {
  kRefresher: token<Refresher>(Symbol.for('@caffeinejs/di:refresher')),
  kRequestScopeManager: token<RequestScopeManager>(Symbol.for('@caffeinejs/di:request-scope-manager')),
  kValuesProvider: token<ValuesProvider>(Symbol('@caffeinejs/di:values-provider')),
  kStandaloneResolver: token<StandaloneResolverConsumer>(Symbol.for('@caffeinejs/di:standalone')),
  kAnnotations: Symbol('@caffeinejs/di:annotations'),
  kMetadata: Symbol('@caffeinejs/di:metadata'),
}
