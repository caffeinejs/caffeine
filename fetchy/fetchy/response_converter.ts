import type { FetchyResponse } from './response.js'

export interface ResponseConverter<T = unknown> {
  convert(response: FetchyResponse): Promise<T>
}

/**
 * Default response converter: parses the body as JSON. An empty body, as on a 204, a `HEAD`
 * response or a 2xx with no content, converts to `undefined`.
 */
export const JSONResponseConverter: ResponseConverter = {
  async convert(response: FetchyResponse): Promise<unknown> {
    if (response.status === 204) {
      return undefined
    }

    const text = await response.text()

    return text === '' ? undefined : JSON.parse(text)
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
