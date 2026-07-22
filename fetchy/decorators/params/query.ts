import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a query string parameter. Array values produce one `key=value` entry per
 * element.
 */
export function Query(key: string): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'query', key, index })
    },
  }
}
