import type { Call, CallFactory } from '../call.js'
import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'

/**
 * Fake {@link Call} that records the last request it received and returns pre-programmed
 * responses or failures, so tests can exercise the full pipeline without a real network.
 */
export class TestCall implements Call {
  lastRequest: FetchyRequest | null = null
  executions = 0
  private readonly outcomes: (Response | Error)[] = []

  willRespond(response: Response): this {
    this.outcomes.push(response)
    return this
  }

  willFail(error: Error): this {
    this.outcomes.push(error)
    return this
  }

  execute(request: FetchyRequest): Promise<FetchyResponse> {
    this.lastRequest = request
    this.executions++
    const outcome = this.outcomes.shift()

    if (!outcome) {
      throw new Error('TestCall has no more programmed responses')
    }

    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
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
