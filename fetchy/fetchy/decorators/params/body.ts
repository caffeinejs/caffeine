import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument as the request body, converted by the request body converter: JSON by default,
 * form-encoded under `@FormURLEncoded()`, multipart under `@Multipart()`, or whatever
 * `@UseRequestBodyConverter()` sets.
 *
 * A `FormData` body is always sent as `multipart/form-data` under the boundary the transport
 * writes, whatever content-type the declaration or an argument names.
 */
export function Body(): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'body', index })
    },
  }
}
