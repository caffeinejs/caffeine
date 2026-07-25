import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a form field. Requires `@FormURLEncoded()` on the same method or class.
 */
export function Field(key: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'form-field', key, index })
    },
  }
}
