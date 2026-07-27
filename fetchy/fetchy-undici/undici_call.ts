import { Readable } from 'node:stream'

import type { Call } from '@caffeinejs/fetchy'
import type { Dispatcher } from 'undici'

import { fromUndiciHeaders, toUndiciHeaders } from './headers_util.js'

const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * `Call` implementation dispatching through an `undici` `Dispatcher` (typically a `Pool`).
 */
export class UndiciCall implements Call {
  constructor(private readonly dispatcher: Dispatcher) {}

  async execute(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const data = await this.dispatcher.request({
      path: url.pathname + url.search,
      method: request.method as Dispatcher.HttpMethod,
      headers: toUndiciHeaders(request.headers),
      body: request.body === null ? null : Readable.fromWeb(request.body),
      signal: request.signal,
    })

    const body = NULL_BODY_STATUSES.has(data.statusCode) ? null : Readable.toWeb(data.body)

    return new Response(body as ReadableStream<Uint8Array> | null, {
      status: data.statusCode,
      statusText: data.statusText,
      headers: fromUndiciHeaders(data.headers),
    })
  }
}
