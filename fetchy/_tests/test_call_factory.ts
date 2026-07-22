import type { Call, CallFactory } from '../call.js'

/**
 * Fake {@link Call} that records the last request it received and returns pre-programmed
 * responses, so tests can exercise the full pipeline without a real network.
 */
export class TestCall implements Call {
  lastRequest: Request | null = null
  private readonly responses: Response[] = []

  willRespond(response: Response): this {
    this.responses.push(response)
    return this
  }

  execute(request: Request): Promise<Response> {
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

  provide(_baseUrl: string): Call {
    const call = new TestCall()
    this.calls.push(call)
    return call
  }

  get lastCall(): TestCall | undefined {
    return this.calls[this.calls.length - 1]
  }
}

export function fakeJsonResponse(status: number, body: unknown, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}
