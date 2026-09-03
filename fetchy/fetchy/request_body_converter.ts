import { ErrFetchyInvalidFormBody } from './errors.js'

// `BodyInit` is a DOM-lib-only type name, unavailable in this package's `lib` set. `RequestInit`
// (the standard Fetch API type) is available via `@types/node`'s ambient fetch globals, so its
// own `body` member type is referenced directly here instead of naming `BodyInit` — this is a
// pointer into the standard type, not a custom one.
type RequestBody = RequestInit['body']

export interface RequestBodyConverter {
  convert(value: unknown): RequestBody
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

    if (
      typeof value === 'string' ||
      value instanceof Blob ||
      value instanceof URLSearchParams ||
      ArrayBuffer.isView(value)
    ) {
      return value as RequestBody
    }

    return JSON.stringify(value)
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
}
