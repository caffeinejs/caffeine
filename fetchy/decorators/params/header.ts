import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a request header.
 */
export function Header(key: string): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'header', key, index })
    },
  }
}
