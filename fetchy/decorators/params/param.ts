import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a `{key}` path placeholder.
 */
export function Param(key: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'path', key, index })
    },
  }
}
