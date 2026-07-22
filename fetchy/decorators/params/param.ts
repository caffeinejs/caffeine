import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a `{key}` path placeholder.
 */
export function Param(key: string): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'path', key, index })
    },
  }
}
