import type { APIParameterSpec } from './api_parameter_spec.js'

/**
 * Binds an argument to a `{key}` path placeholder.
 *
 * A call with `undefined` or `null` for it fails with `ErrFetchyMissingPathArgument` before anything
 * is sent. So does one that makes its segment empty, `"."` or `".."`, alone or with the text around
 * the placeholder, with `ErrFetchyInvalidPathArgument`: a URL parser drops a `"."` segment and
 * resolves `".."` against the segment before it, and many servers drop an empty one.
 */
export function Param(key: string): APIParameterSpec {
  return {
    apply({ spec, index }) {
      spec.param({ kind: 'path', key, index })
    },
  }
}
