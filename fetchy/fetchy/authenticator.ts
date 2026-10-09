import { ErrFetchyFollowUpNotSent, ErrFetchyTooManyAuthenticationAttempts } from './errors.js'
import { discard } from './internal/discard.js'
import { isReplayable } from './internal/replayable.js'
import type { FetchyRequest } from './request.js'
import type { FetchyResponse } from './response.js'
import type { Transport } from './transport.js'

/**
 * Answers a 401 response with a follow-up request that carries credentials, or `null` to give up. Set one with
 * `FetchyBuilder.authenticator()`. Every 401 a call of that client receives reaches it, a login's wrong password
 * included: return `null` for one your credentials do not answer.
 *
 * It runs between the interceptors and the transport: `request` is the request as the transport sent it, and the
 * follow-up goes straight to the transport. Interceptors see one request per call and the response that ends it, and
 * do not run for the follow-up: compute again here what one computes per request, such as a signature or a timestamp.
 * Build the follow-up with `request.clone()`, which keeps what the interceptors set, the origin and the call's signal.
 *
 * `attempt` is the attempt the 401 answers: 1 for the request as first sent, 2 for the first follow-up. Return `null`
 * once it is past the rounds your scheme needs: 2 covers the token held, then a refreshed one, and a Digest nonce gone
 * stale. A call sends at most 3 follow-ups and fails with {@link ErrFetchyTooManyAuthenticationAttempts} on the next
 * 401, without asking again. A scheme bound to one connection, such as NTLM or Negotiate, cannot complete: a follow-up
 * may leave on another.
 *
 * Returning `null` ends the call with the 401, and an error `authenticate` throws fails the call as is. A follow-up to
 * another origin, or one whose body is a stream or an iterator the first send may have read, fails the call with
 * {@link ErrFetchyFollowUpNotSent}; `authenticate` was still asked, so credentials it refreshed serve the calls that
 * follow. A call whose signal aborts rejects with the abort reason once `authenticate` returns, and one aborted before
 * its 401 is not authenticated.
 *
 * The 401's body is the authenticator's to read until it returns: release or cancel any reader first, since a body
 * still locked to one cannot be cancelled and keeps its connection. What is left unread is cancelled before the
 * follow-up is sent. A body read and then answered with `null` leaves the caller's `ErrFetchyHTTP.body` undefined.
 *
 * One expired credential sends every call in flight to `authenticate` at once: share one refresh among them, and
 * refresh only when `request` still carries the current credential. Bound the refresh with a timeout, and never send
 * it through a client this authenticator serves: a 401 there would wait on the refresh it is part of. A challenge
 * comes from the server: check any URL you take from it before sending credentials there.
 */
export interface Authenticator {
  authenticate(request: FetchyRequest, response: FetchyResponse, attempt: number): Promise<FetchyRequest | null>
}

// The most follow-ups one request gets. 2 covers the token held, then a refreshed one, and a Digest nonce gone stale;
// the third is spare. A scheme bound to one connection, such as NTLM or Negotiate, cannot complete at all: the 401 is
// cancelled, and the follow-up may leave on another connection.
const MAX_FOLLOW_UPS = 3

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
      .then(response => (response.status === 401 ? this.answer(request, response, 1) : response))
  }

  // Answers the 401 that `request` received on its `attempt`, and in turn any 401 its follow-up receives.
  private async answer(request: FetchyRequest, response: FetchyResponse, attempt: number): Promise<FetchyResponse> {
    let next: FetchyRequest | null | undefined

    try {
      request.signal?.throwIfAborted()

      if (attempt > MAX_FOLLOW_UPS) {
        throw new ErrFetchyTooManyAuthenticationAttempts(request, MAX_FOLLOW_UPS)
      }

      next = await this.authenticator.authenticate(request, response, attempt)
      request.signal?.throwIfAborted()

      if (next === null || next === undefined) {
        return response
      }

      if (next.origin !== request.origin) {
        throw new ErrFetchyFollowUpNotSent(request, 'origin')
      }

      if (!isReplayable(next.body)) {
        throw new ErrFetchyFollowUpNotSent(request, 'body')
      }
    } catch (error) {
      await discard(response)
      throw error
    }

    await discard(response)

    const reply = await this.transport.send(next)

    return reply.status === 401 ? this.answer(next, reply, attempt + 1) : reply
  }
}
