import { ErrFetchyInvalidFormBody, ErrFetchyInvalidMultipartBody } from './errors.js'
import { isFormData } from './internal/form_data.js'
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
   * `content-type`, so `@ContentType` and `@FormURLEncoded` still win, and never for a `FormData`, which the
   * transport labels with its boundary.
   */
  contentType?(value: unknown): string | undefined
}

/** True of a value the JSON converter hands to `fetch` untouched rather than stringifying. */
function isNativeBody(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    value instanceof Blob ||
    value instanceof URLSearchParams ||
    ArrayBuffer.isView(value) ||
    isFormData(value)
  )
}

/**
 * Default request body converter: passes through values that are already valid fetch body types
 * (string, `Blob`, `URLSearchParams`, typed arrays, `FormData`), JSON-stringifies everything else.
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
  // `URLSearchParams` itself, the transport labels a `FormData` with its boundary, and a string may be
  // anything — claiming JSON for those would be a lie the server acts on.
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

function appendFormValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    params.append(key, String(value))
  }
}

/**
 * Converts a plain object, a `URLSearchParams` instance, or a 2D array of `[key, value]` pairs
 * into an `application/x-www-form-urlencoded` string, leaving out `undefined` and `null` values,
 * as `@Field()` does. A string, a `Blob` or a typed array is already encoded and passes through
 * untouched.
 *
 * @throws {@link ErrFetchyInvalidFormBody} for a flat array, or a `FormData`, which `@Multipart()` sends.
 */
export const FormRequestBodyConverter: RequestBodyConverter = {
  convert(value: unknown): RequestBody {
    if (value === null || value === undefined) {
      return null
    }

    if (value instanceof URLSearchParams) {
      return value.toString()
    }

    if (typeof value !== 'object' || isNativeBody(value)) {
      if (isFormData(value)) {
        throw new ErrFetchyInvalidFormBody('form-data')
      }

      return value as RequestBody
    }

    const params = new URLSearchParams()

    if (Array.isArray(value)) {
      if (value.length > 0 && !Array.isArray(value[0])) {
        throw new ErrFetchyInvalidFormBody('pairs')
      }

      for (const [key, val] of value as [string, unknown][]) {
        appendFormValue(params, key, val)
      }

      return params.toString()
    }

    for (const [key, val] of Object.entries(value)) {
      appendFormValue(params, key, val)
    }

    return params.toString()
  },

  contentType(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : MediaTypes.FORM_URL_ENCODED
  },
}

function appendPartValue(form: FormData, name: string, value: unknown): void {
  if (typeof value === 'string' || value instanceof Blob) {
    form.append(name, value)
    return
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    form.append(name, String(value))
    return
  }

  throw new ErrFetchyInvalidMultipartBody(value, name)
}

// Adds a part the way `@Part()` takes it: an array as one part per element, one level deep, and `undefined` or `null`,
// alone or in an array, as no part at all.
export function appendPart(form: FormData, name: string, value: unknown): void {
  if (value === undefined || value === null) {
    return
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      if (element !== undefined && element !== null) {
        appendPartValue(form, name, element)
      }
    }

    return
  }

  appendPartValue(form, name, value)
}

// `Object.entries` reads a Map or a Date as empty, a typed array as its indexes, and a class instance as its own fields
// alone, not what its getters expose. Only a plain object's properties are exactly its parts.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

/**
 * Converts a plain object into a `FormData`, one part per property, under the rules `Part()`
 * follows. A `FormData` passes through untouched. Neither carries a `content-type`: the transport
 * labels the body `multipart/form-data` with the boundary it generates.
 *
 * @throws {@link ErrFetchyInvalidMultipartBody} for any other value, or a property that cannot be a part.
 */
export const MultipartRequestBodyConverter: RequestBodyConverter = {
  convert(value: unknown): RequestBody {
    if (value === null || value === undefined) {
      return null
    }

    if (isFormData(value)) {
      return value
    }

    if (!isPlainObject(value)) {
      throw new ErrFetchyInvalidMultipartBody(value)
    }

    const form = new FormData()

    for (const [name, part] of Object.entries(value)) {
      appendPart(form, name, part)
    }

    return form
  },
}
