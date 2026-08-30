import { token } from './key.js'
import type { Refresher } from './refresher.js'
import type { RequestScopeManager } from './request_scope_manager.js'

export const Keys = {
  kRefresher: token<Refresher>(Symbol.for('@caffeinejs/di:refresher')),
  kRequestScopeManager: token<RequestScopeManager>(Symbol.for('@caffeinejs/di:request-scope-manager')),
  kValuesProvider: token<unknown>(Symbol('@caffeinejs/di:values-provider')),
  kAnnotations: Symbol('@caffeinejs/di:annotations'),
  kMetadata: Symbol('@caffeinejs/di:metadata'),
}
