import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'

export interface Call {
  execute(request: FetchyRequest): Promise<FetchyResponse>
}

export interface CallFactory {
  provide(baseURL: string): Call
}
