import type { Call, CallFactory } from '../call.js'
import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'

/**
 * Fake {@link Call} that records the last request it received and returns pre-programmed
 * responses, so tests can exercise the full pipeline without a real network.
 */
export class TestCall implements Call {
  lastRequest: FetchyRequest | null = null
  private readonly responses: Response[] = []

  willRespond(response: Response): this {
    this.responses.push(response)
    return this
  }

  execute(request: FetchyRequest): Promise<FetchyResponse> {
    this.lastRequest = request
    const response = this.responses.shift()

    if (!response) {
      throw new Error('TestCall has no more programmed responses')
    }

    return Promise.resolve(response)
  }
}

export class TestCallFactory implements CallFactory {
  readonly calls: TestCall[] = []

  provide(_baseURL: string): Call {
    const call = new TestCall()
    this.calls.push(call)
    return call
  }

  get lastCall(): TestCall | undefined {
    return this.calls[this.calls.length - 1]
  }
}

export function fakeJSONResponse(status: number, body: unknown, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}
