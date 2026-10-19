import { discard } from './_discard.js'
import { ErrBrewFollowUpNotSent, ErrBrewTooManyFollowUps } from './errors.js'
import { intercept, type Interceptor } from './interceptor.js'

/**
 * Answers a 401 with the request to send in its place, or `null` to let the call resolve with the 401.
 *
 * Set with `BrewOptions.authenticator`, it runs around the interceptors. `request` is a copy of the request that got
 * the 401 as the client built it, before any interceptor, its body ready to be sent again: set the credentials on it
 * and return it, since `new Request(request, { headers })` would replace every header it had. The follow-up goes
 * through the interceptors again, and an interceptor that sets the same header sets it over this one.
 *
 * `attempt` is 1 for the 401 to the request as first sent, and one more for each follow-up. A call sends at most
 * `maxFollowUps` follow-ups, 3 unless set, and rejects on the next 401 with {@link ErrBrewTooManyFollowUps} without
 * asking: return `null` once the credentials you hold are refused.
 *
 * Only the call's own server is answered. A 401 that `fetch` reached by following a redirect to another origin goes to
 * the caller, and a follow-up to another origin rejects with {@link ErrBrewFollowUpNotSent}, so credentials stay with
 * the server that asked for them. A stream passed as the body is read as it is sent: `request` comes without it, and a
 * follow-up rejects with the same error. A body given as a function that returns the stream is opened anew instead.
 *
 * `response` is a copy of the 401 while its body is unread, so a body read here is still the caller's when the answer
 * is `null`: release any reader before returning. What is left of the 401 is cancelled before the follow-up goes.
 *
 * Every call in flight when a credential expires is answered at once: share one refresh among them, and refresh only
 * when `request` still carries the credential the server refused. That is why a credential to compare belongs in the
 * client's `headers`, which a follow-up does not resolve again, and not in an interceptor, which this never sees.
 * Never refresh through a client this authenticator serves: a 401 there would wait on the refresh it is part of. A call
 * whose signal aborts has already rejected with its reason, and one aborted before its 401 is not asked about.
 */
export type Authenticator = (
  request: Request,
  response: Response,
  attempt: number,
) => Request | null | undefined | Promise<Request | null | undefined>

// Two rounds cover the credential held, then a refreshed one, and a Digest nonce gone stale; the third is spare.
export const MAX_FOLLOW_UPS = 3

/** What the authenticator step needs of the call it answers for. */
export interface Answering {
  readonly authenticator: Authenticator
  readonly limit: number
  readonly signal: AbortSignal | null | undefined
  /** Whether the call's body was read as it was sent, so that no follow-up can carry it. */
  readonly oneShot: boolean
  /** A copy of `sent` under `headers`, carrying the call's body anew. */
  copy(sent: Request, headers: Headers): Request
}

// 401s that `fetch` reached by following a redirect to another origin: that origin's challenge, not the call's.
const elsewhere = new WeakSet<Response>()

// Sends `first` through the interceptors, and answers each 401 it meets with the authenticator's follow-up.
export async function authenticate(
  first: Request,
  interceptors: readonly Interceptor[],
  transport: (request: Request) => Promise<Response>,
  answering: Answering,
): Promise<Response> {
  const chain = intercept(interceptors, noting(transport))
  const origin = new URL(first.url).origin
  let sent = first

  for (let attempt = 1; ; attempt++) {
    // Taken before the chain runs: an interceptor may set headers of its own on the request, and those are not the
    // call's.
    const headers = new Headers(sent.headers)
    const response = await chain(sent)

    if (response.status !== 401 || elsewhere.has(response)) {
      return response
    }

    const challenge = unread(response) ? response.clone() : response
    let followUp: Request | null | undefined

    try {
      answering.signal?.throwIfAborted()
      if (!(attempt <= answering.limit)) {
        throw new ErrBrewTooManyFollowUps(first, attempt - 1, answering.limit)
      }

      followUp = await answering.authenticator(answering.copy(sent, headers), challenge, attempt)
      answering.signal?.throwIfAborted()

      if (followUp === null || followUp === undefined) {
        // The 401 itself is the caller's, unread; the copy would hold back the caller's own cancel. Not awaited: the
        // copy's cancel settles only once the caller's body is done with too.
        if (challenge !== response) {
          void discard(challenge)
        }
        return response
      }

      if (new URL(followUp.url).origin !== origin) {
        throw new ErrBrewFollowUpNotSent(first, 'origin')
      }

      if (answering.oneShot) {
        throw new ErrBrewFollowUpNotSent(first, 'stream')
      }
    } catch (error) {
      await discard(response, challenge, followUp)
      throw error
    }

    await discard(response, challenge)
    sent = followUp
  }
}

// `transport`, noting a 401 it reached by following a redirect to another origin.
function noting(transport: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async request => {
    const response = await transport(request)
    if (
      response.status === 401 &&
      response.redirected &&
      response.url !== '' &&
      new URL(response.url).origin !== new URL(request.url).origin
    ) {
      elsewhere.add(response)
    }

    return response
  }
}

// A 401 whose body nobody has started to read: a copy of it keeps the body whole for the caller.
function unread(response: Response): boolean {
  return response.body !== null && !response.bodyUsed && !response.body.locked
}
