import type { FetchyResponse } from './response.js'

export interface ResponseConverter<T = unknown> {
  convert(response: FetchyResponse): Promise<T>
}

/**
 * Default response converter: parses the body as JSON, treating an empty (204) response as
 * `undefined`.
 */
export const JSONResponseConverter: ResponseConverter = {
  async convert(response: FetchyResponse): Promise<unknown> {
    if (response.status === 204) {
      return undefined
    }

    return response.json()
  },
}

/**
 * Passes the transport's {@link FetchyResponse} through untouched.
 */
export const RawResponseConverter: ResponseConverter<FetchyResponse> = {
  convert(response: FetchyResponse): Promise<FetchyResponse> {
    return Promise.resolve(response)
  },
}

/**
 * Reads the body as plain text, treating an empty (204) response as `''`.
 */
export const TextResponseConverter: ResponseConverter<string> = {
  async convert(response: FetchyResponse): Promise<string> {
    if (response.status === 204) {
      return ''
    }

    return response.text()
  },
}
