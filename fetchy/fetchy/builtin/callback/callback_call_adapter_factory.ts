import type { CallAdapter, CallAdapterFactory } from '../../call_adapter.js'
import type { MethodSpec } from '../../decorators/registrar/index.js'
import { CallbackCallAdapter } from './callback_call_adapter.js'

/**
 * Selects {@link CallbackCallAdapter} for methods decorated with `@Callback()`. Not registered by
 * default — register via `FetchyBuilder.addCallAdapterFactory(new CallbackCallAdapterFactory())`.
 */
export class CallbackCallAdapterFactory implements CallAdapterFactory {
  provide(spec: MethodSpec): CallAdapter<unknown> | null {
    return spec.callback ? CallbackCallAdapter.INSTANCE : null
  }
}
