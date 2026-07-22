import type { ApiParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a form field. Requires `@FormUrlEncoded()` on the same method or class.
 */
export function Field(key: string): ApiParameterSpec {
  return {
    apply({ meta, index }) {
      meta.params.push({ kind: 'form-field', key, index })
    },
  }
}
