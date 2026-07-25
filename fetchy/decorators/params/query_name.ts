import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as a value-less query fragment (e.g. `?flag` instead of `?flag=value`).
 */
export function QueryName(): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'query-name', index })
    },
  }
}
