import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an `AbortSignal` argument, used to cancel the outgoing request.
 */
export function SignalParam(): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'signal', index })
    },
  }
}
