import type { FetchyRequest } from '../request.js'
import type { FetchyResponse } from '../response.js'
import type { Transport, TransportFactory } from '../transport.js'

/**
 * Fake {@link Transport} that records the last request it received and returns pre-programmed
 * responses or failures, so tests can exercise the full pipeline without a real network.
 */
export class TestTransport implements Transport {
  lastRequest: FetchyRequest | null = null
  sendCount = 0
  private readonly outcomes: (Response | Error)[] = []

  willRespond(response: Response): this {
    this.outcomes.push(response)
    return this
  }

  willFail(error: Error): this {
    this.outcomes.push(error)
    return this
  }

  send(request: FetchyRequest): Promise<FetchyResponse> {
    this.lastRequest = request
    this.sendCount++
    const outcome = this.outcomes.shift()

    if (!outcome) {
      throw new Error('TestTransport has no more programmed responses')
    }

    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
  }
}

export class TestTransportFactory implements TransportFactory {
  readonly transports: TestTransport[] = []

  provide(_baseURL: string): Transport {
    const transport = new TestTransport()
    this.transports.push(transport)
    return transport
  }

  get lastTransport(): TestTransport | undefined {
    return this.transports[this.transports.length - 1]
  }
}

export function fakeJSONResponse(status: number, body: unknown, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}
