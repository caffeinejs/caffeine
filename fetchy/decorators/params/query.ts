import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a query string parameter. Array values produce one `key=value` entry per
 * element.
 */
export function Query(key: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'query', key, index })
    },
  }
}
