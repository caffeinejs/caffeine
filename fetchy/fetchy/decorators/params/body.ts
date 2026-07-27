import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as the request body, converted per `MethodSpec.requestType` (JSON by default).
 */
export function Body(): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'body', index })
    },
  }
}
