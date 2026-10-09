import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a part of a `multipart/form-data` body. Requires `@Multipart()` on the same
 * method or class.
 *
 * A string, number, boolean or bigint is sent as text, its line breaks as CRLF, as browsers send
 * form fields. A `File` is sent as a file under its own name and type, and a `Blob` under the name
 * `blob`: to name one, pass `new File([blob], 'report.pdf', { type: blob.type })`. Each element of
 * an array is a part of its own. `undefined` and `null` add no part.
 *
 * Any other value fails the call with `ErrFetchyInvalidMultipartBody` before anything is sent. To
 * send an object, pass it as JSON in a `Blob`:
 * `new Blob([JSON.stringify(value)], { type: 'application/json' })`.
 */
export function Part(name: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'part', key: name, index })
    },
  }
}
