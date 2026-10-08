import { ErrFetchyTooManyAuthenticationAttempts } from './errors.js'
import { isReplayable } from './internal/replayable.js'
import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'
import type { Transport } from './transport.js'

/**
 * Answers a 401 response with a follow-up request that carries credentials, or `null` to give up. Set one with
 * `FetchyBuilder.authenticator()`.
 *
 * It runs between the interceptors and the transport: `request` is the request as the transport sent it, and the
 * follow-up goes straight to the transport, so interceptors see one request per call and the response that ends it.
 * Build the follow-up with `request.clone()`, which keeps what the interceptors set and the call's signal.
 *
 * `attempt` is the attempt the 401 answers: 1 for the request as first sent, 2 for the first follow-up. A call sends
 * at most 3 follow-ups: returning a 4th fails it with {@link ErrFetchyTooManyAuthenticationAttempts}. Returning `null`
 * ends the call with the 401, and an error `authenticate` throws fails the call as is.
 *
 * The 401's body is the authenticator's to read until it returns: what it leaves unread is cancelled before a
 * follow-up is sent. A follow-up whose body is a stream or an iterator is not sent, since the first send may have read
 * it, and the call ends with the 401.
 *
 * One expired credential sends every call in flight to `authenticate` at once: share one refresh among them, and
 * refresh only when `request` still carries the current credential. A call waits for its authenticator even after its
 * signal aborts, so bound a refresh with a timeout. Never send the refresh through a client this authenticator serves:
 * a 401 there would wait on the refresh it is part of.
 */
export interface Authenticator {
  authenticate(request: FetchyRequest, response: FetchyResponse, attempt: number): Promise<FetchyRequest | null>
}

// Every standard scheme completes within two follow-ups: an NTLM handshake, a Digest nonce gone stale.
const MAX_FOLLOW_UPS = 3

// Frees the connection the 401 holds. A body the authenticator read is locked, and finishing it is the reader's job.
async function discard(response: FetchyResponse): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel()
  }
}

// What a client with an authenticator sends through. A client without one sends through its transport directly.
export class AuthenticatingTransport implements Transport {
  constructor(
    private readonly transport: Transport,
    private readonly authenticator: Authenticator,
  ) {}

  send(request: FetchyRequest): Promise<FetchyResponse> {
    // A callback, not an async method: on the path every call takes, it costs one promise and no async frame.
    return this.transport
      .send(request)
      .then(response => (response.status === 401 ? this.followUp(request, response) : response))
  }

  private async followUp(request: FetchyRequest, response: FetchyResponse): Promise<FetchyResponse> {
    for (let attempt = 1; response.status === 401; attempt++) {
      let next: FetchyRequest | null

      try {
        next = await this.authenticator.authenticate(request, response, attempt)
      } catch (error) {
        // The authenticator's failure is the one the caller needs, so a cancel that fails too stays quiet.
        await discard(response).catch(() => undefined)
        throw error
      }

      if (next === null || !isReplayable(next.body)) {
        return response
      }

      await discard(response)

      if (attempt > MAX_FOLLOW_UPS) {
        throw new ErrFetchyTooManyAuthenticationAttempts(request, attempt)
      }

      request = next
      response = await this.transport.send(request)
    }

    return response
  }
}
