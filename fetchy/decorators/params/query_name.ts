import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as a value-less query fragment (e.g. `?flag` instead of `?flag=value`).
 */
export function QueryName(): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'query-name', index })
    },
  }
}
