import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as the request body, converted per `methodMeta.requestType` (JSON by default).
 */
export function Body(): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'body', index })
      meta.bodyIndex = index
    },
  }
}
