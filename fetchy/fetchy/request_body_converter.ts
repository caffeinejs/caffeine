import { ErrFetchyInvalidFormBody } from './errors.js'
import { MediaTypes } from './media_types.js'

// `BodyInit` is a DOM-lib-only type name, unavailable in this package's `lib` set. `RequestInit`
// (the standard Fetch API type) is available via `@types/node`'s ambient fetch globals, so its
// own `body` member type is referenced directly here instead of naming `BodyInit` — this is a
// pointer into the standard type, not a custom one.
type RequestBody = RequestInit['body']

export interface RequestBodyConverter {
  convert(value: unknown): RequestBody

  /**
   * The media type the body `convert` produces for this value, or `undefined` when the converter has no
   * opinion about it.
   *
   * Asked per value rather than declared once, because a converter that passes some values through untouched
   * does not describe them all the same way. The request builder sets it only when nothing else already set
   * `content-type`, so `@ContentType` and `@FormURLEncoded` still win.
   */
  contentType?(value: unknown): string | undefined
}

/** True of a value the JSON converter hands to `fetch` untouched rather than stringifying. */
function isNativeBody(value: unknown): boolean {
  return (
    typeof value === 'string' || value instanceof Blob || value instanceof URLSearchParams || ArrayBuffer.isView(value)
  )
}

/**
 * Default request body converter: passes through values that are already valid fetch body types
 * (string, `Blob`, `URLSearchParams`, typed arrays), JSON-stringifies everything else.
 */
export const JSONRequestBodyConverter: RequestBodyConverter = {
  convert(value: unknown): RequestBody {
    if (value === null || value === undefined) {
      return null
    }

    if (isNativeBody(value)) {
      return value as RequestBody
    }

    return JSON.stringify(value)
  },

  // Only what this converter stringified is JSON. A `Blob` carries its own type, `fetch` labels a
  // `URLSearchParams` itself, and a string may be anything — claiming JSON for those would be a lie the
  // server acts on.
  contentType(value: unknown): string | undefined {
    if (value === null || value === undefined || isNativeBody(value)) {
      return undefined
    }

    return MediaTypes.JSON
  },
}

/**
 * Passes the value through untouched, used when no conversion should happen.
 */
export const RawRequestBodyConverter: RequestBodyConverter = {
  convert(value: unknown): RequestBody {
    return value as RequestBody
  },
}

/**
 * Converts a plain object, a `URLSearchParams` instance, or a 2D array of `[key, value]` pairs
 * into an `application/x-www-form-urlencoded` string.
 */
export const FormRequestBodyConverter: RequestBodyConverter = {
  convert(value: unknown): RequestBody {
    if (value === null || value === undefined) {
      return null
    }

    if (value instanceof URLSearchParams) {
      return value.toString()
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && !Array.isArray(value[0])) {
        throw new ErrFetchyInvalidFormBody()
      }

      const params = new URLSearchParams()

      for (const [key, val] of value as [string, string][]) {
        params.append(key, val)
      }

      return params.toString()
    }

    if (typeof value === 'object') {
      return new URLSearchParams(value as Record<string, string>).toString()
    }

    return value as RequestBody
  },

  contentType(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : MediaTypes.FORM_URL_ENCODED
  },
}
