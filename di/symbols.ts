import { token } from './key.js'
import type { Refresher } from './refresher.js'
import type { RequestScopeManager } from './request_scope_manager.js'

/** Placeholder consumer for {@link Container.resolver} — never constructed. */
interface StandaloneResolverConsumer {
  readonly __caffeineStandaloneResolver: never
}

/**
 * Placeholder for the config provider. Its real shape is the application's configuration, which the container
 * cannot name — {@link Container.bindConfigProvider} re-types the key to the caller's `T`.
 */
interface ConfigProvider {
  readonly __caffeineConfigProvider: never
}

export const Keys = {
  kRefresher: token<Refresher>(Symbol.for('@caffeinejs/di:refresher')),
  kRequestScopeManager: token<RequestScopeManager>(Symbol.for('@caffeinejs/di:request-scope-manager')),
  kConfigProvider: token<ConfigProvider>(Symbol('@caffeinejs/di:config-provider')),
  kStandaloneResolver: token<StandaloneResolverConsumer>(Symbol.for('@caffeinejs/di:standalone')),
  kAnnotations: Symbol('@caffeinejs/di:annotations'),
  kMetadata: Symbol('@caffeinejs/di:metadata'),
}
