import type { Call, CallFactory } from '../../call.js'
import { FetchCall } from './fetch_call.js'

/**
 * Default {@link CallFactory}, used automatically by `FetchyBuilder.build()` when no explicit
 * `.callFactory()` was configured.
 */
export class FetchCallFactory implements CallFactory {
  provide(_baseURL: string): Call {
    return new FetchCall()
  }
}
