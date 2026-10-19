import type { Authenticator } from '../index.js'

/**
 * An access token kept the way an application keeps one: every call sends it from the client's `headers`, and every
 * call a 401 sends to the authenticator at the same time shares one refresh.
 */
export class Tokens {
  access: string
  readonly #refresh: () => Promise<string>
  #refreshing: Promise<void> | undefined

  constructor(access: string, refresh: () => Promise<string>) {
    this.access = access
    this.#refresh = refresh
  }

  /** For the client's `headers`: the token as it stands when the call is made. */
  readonly headers = (): Record<string, string> => ({ authorization: `Bearer ${this.access}` })

  /**
   * Refreshes only when the request still carries the token held, since a call refused for an older one needs only the
   * current one. Gives up on the second 401: a token just refreshed and still refused will not do better.
   */
  readonly authenticator: Authenticator = async (request, _response, attempt) => {
    if (attempt > 1) {
      return null
    }

    if (request.headers.get('authorization') === `Bearer ${this.access}`) {
      // Publishes the token and frees the slot in one step: a 401 handled between the two would find the slot free and
      // the old token still current, and start a second refresh.
      await (this.#refreshing ??= this.#refresh().then(
        token => {
          this.access = token
          this.#refreshing = undefined
        },
        (error: unknown) => {
          this.#refreshing = undefined
          throw error
        },
      ))
    }

    request.headers.set('authorization', `Bearer ${this.access}`)

    return request
  }
}
