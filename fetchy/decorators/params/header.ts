import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a request header.
 */
export function Header(key: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'header', key, index })
    },
  }
}
