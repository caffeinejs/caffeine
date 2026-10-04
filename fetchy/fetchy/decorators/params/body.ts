import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as the request body, converted by the request body converter: JSON by default,
 * form-encoded under `@FormURLEncoded()`, or whatever `@UseRequestBodyConverter()` sets.
 */
export function Body(): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'body', index })
    },
  }
}
