import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an `AbortSignal` argument, used to cancel the outgoing request.
 */
export function SignalParam(): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'signal', index })
    },
  }
}
