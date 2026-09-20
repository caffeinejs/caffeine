import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http'

import { Cookie, CookieJar } from 'tough-cookie'

/**
 * A scripted browser for the authentication e2e specs: real sockets, a cookie jar that enforces what a browser
 * enforces, and the request headers a browser sends for a navigation or for a script-initiated request.
 *
 * Built on `node:http` rather than `fetch` on purpose. `fetch` writes `Sec-Fetch-Mode` itself (always `cors`), so
 * a navigation could not be told apart from an XHR, and that distinction is exactly what a challenge is decided on.
 * It also folds repeated response headers into one line; `headersDistinct` here keeps them apart.
 */

const NAVIGATION_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

const SCRIPT_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export interface BrowserResponse {
  /** The URL this response answered. */
  readonly url: string
  readonly status: number
  readonly headers: IncomingHttpHeaders
  /** Every header as the list of lines it arrived on, so a header sent twice is seen twice. */
  readonly headersDistinct: NodeJS.Dict<string[]>
  text(): string
  json<T = unknown>(): T
}

/** One step of a navigation: the URL requested, what it answered, and where it pointed next. */
export interface Hop {
  readonly url: string
  readonly status: number
  readonly location: string | undefined
  readonly headers: IncomingHttpHeaders
}

export interface Page extends BrowserResponse {
  /** Every request the navigation made, in order, the last one being this page. */
  readonly hops: readonly Hop[]
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export class Browser {
  // `prefixSecurity: 'strict'` makes the jar refuse a `__Host-` / `__Secure-` cookie a browser would refuse.
  // `localhost` is a special-use domain and no public suffix, so both checks are relaxed for it and nothing else.
  readonly #jar = new CookieJar(undefined, {
    prefixSecurity: 'strict',
    rejectPublicSuffixes: false,
    allowSpecialUseDomain: true,
  })

  // One connection per request. A kept-alive socket outlives the application it was opened to, and the specs
  // restart applications on one port: a browser retries a dead connection by itself, `node:http` hangs up instead.
  readonly #agent = new Agent({ keepAlive: false })

  /**
   * Opens `url` the way typing it into the address bar does, following redirects until a response that is not one.
   *
   * @throws Error when the chain is longer than `maxHops`, which in practice means a redirect loop.
   */
  async navigate(url: string, maxHops = 20): Promise<Page> {
    return this.#follow(url, { method: 'GET', headers: NAVIGATION_HEADERS }, maxHops)
  }

  /** Submits an HTML form, then follows the redirects the way a browser does after a POST. */
  async submit(url: string, fields: Record<string, string>, maxHops = 20): Promise<Page> {
    return this.#follow(
      url,
      {
        method: 'POST',
        headers: {
          ...NAVIGATION_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          origin: new URL(url).origin,
        },
        body: new URLSearchParams(fields).toString(),
      },
      maxHops,
    )
  }

  /** A script-initiated request (`fetch` / `XMLHttpRequest`): never follows a redirect, still uses the jar. */
  async xhr(url: string, options: RequestOptions = {}): Promise<BrowserResponse> {
    return this.#send(url, { ...options, headers: { ...SCRIPT_HEADERS, ...options.headers } })
  }

  /** A script-initiated JSON POST. */
  async postJSON(url: string, body: unknown, headers: Record<string, string> = {}): Promise<BrowserResponse> {
    return this.xhr(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(url).origin, ...headers },
      body: JSON.stringify(body),
    })
  }

  /** The cookies the jar would send to `url`, expired ones excluded. */
  cookies(url: string): Promise<Cookie[]> {
    return this.#jar.getCookies(url)
  }

  async cookie(url: string, name: string): Promise<Cookie | undefined> {
    return (await this.cookies(url)).find(cookie => cookie.key === name)
  }

  /** The first cookie for `url` whose name contains `fragment`; names here are namespaced by strategy. */
  async cookieLike(url: string, fragment: string): Promise<Cookie | undefined> {
    return (await this.cookies(url)).find(cookie => cookie.key.includes(fragment))
  }

  /** Plants a cookie another browser holds, the way a synced profile or a captured header would. */
  async adoptCookie(url: string, cookie: Cookie): Promise<void> {
    // Serialized rather than shared: a jar writes to the cookies it stores.
    await this.#jar.setCookie(cookie.toString(), url)
  }

  /**
   * Hands the jar one `Set-Cookie` line as if `url` had sent it, and lets the jar decide what to do with it. A line
   * the jar refuses changes nothing, which is what a browser does with it too.
   */
  async setCookieLine(url: string, line: string): Promise<void> {
    await this.#jar.setCookie(line, url, { ignoreError: true })
  }

  /** Rewrites the value of a cookie the jar holds, leaving every attribute as the server set it. */
  async tamperCookie(url: string, name: string, change: (value: string) => string): Promise<void> {
    const cookie = await this.#held(url, name)

    await this.#jar.setCookie(rewritten(cookie, { value: change(cookie.value) }), url)
  }

  /** Forgets one cookie, which is what its expiry looks like from the server's side. */
  async dropCookie(url: string, name: string): Promise<void> {
    const cookie = await this.#held(url, name)

    // Overwritten with an already-expired copy: the jar's own rules then remove it.
    await this.#jar.setCookie(rewritten(cookie, { value: '', expires: new Date(0) }), url)
  }

  async #held(url: string, name: string): Promise<Cookie> {
    const cookie = await this.cookie(url, name)
    if (cookie === undefined) {
      throw new Error(`The jar holds no cookie "${name}" for ${url}`)
    }

    return cookie
  }

  async #follow(url: string, first: RequestOptions, maxHops: number): Promise<Page> {
    const hops: Hop[] = []
    let current = url
    let options = first

    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.#send(current, options)
      const location = response.headers.location

      hops.push({ url: current, status: response.status, location, headers: response.headers })

      if (!REDIRECTS.has(response.status) || location === undefined) {
        return Object.assign(response, { hops })
      }

      current = new URL(location, current).toString()

      // 307 and 308 keep the method and the body; everything else a browser turns into a GET.
      if (response.status !== 307 && response.status !== 308) {
        options = { method: 'GET', headers: NAVIGATION_HEADERS }
      }
    }

    throw new Error(`Navigation did not settle within ${maxHops} hops: ${hops.map(hop => hop.url).join(' -> ')}`)
  }

  async #send(url: string, options: RequestOptions): Promise<BrowserResponse> {
    const cookie = await this.#jar.getCookieString(url)
    const headers: Record<string, string> = { ...options.headers }

    if (cookie.length > 0) {
      headers.cookie = cookie
    }

    if (options.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(options.body))
    }

    const response = await send(this.#agent, url, options.method ?? 'GET', headers, options.body)

    for (const line of response.headersDistinct['set-cookie'] ?? []) {
      // A cookie the jar refuses is one a browser refuses; that is a result to observe, not an error to raise.
      await this.#jar.setCookie(line, url, { ignoreError: true })
    }

    return response
  }
}

/** The same cookie with some properties changed. Host-only stays host-only: no `Domain` is ever written. */
function rewritten(cookie: Cookie, changes: { value: string; expires?: Date }): Cookie {
  return new Cookie({
    key: cookie.key,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
    maxAge: cookie.maxAge,
    ...changes,
  })
}

function send(
  agent: Agent,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<BrowserResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent, method, headers }, response => {
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')

        resolve({
          url,
          status: response.statusCode ?? 0,
          headers: response.headers,
          headersDistinct: response.headersDistinct,
          text: () => text,
          json: <T>() => JSON.parse(text) as T,
        })
      })
    })

    request.on('error', reject)
    request.end(body)
  })
}
