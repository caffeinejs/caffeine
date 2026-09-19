import { setTimeout as delay } from 'node:timers/promises'

import type { Duration } from '../../duration/duration.js'
import { ErrConfig, messageOf } from '../errors.js'
import { expandKeys } from '../merge.js'
import { pollDelay } from '../triggers.js'
import type { ConfigLayer, ConfigLoadContext, ConfigObject, ConfigSource, ConfigValue } from '../types.js'

/** The pause before the first retry of a URL. It doubles per retry, as the pause of a failing poll does. */
const RETRY_DELAY_MS = 100

export interface SpringCloudConfigSourceOptions {
  /** The application name: the first path segment of the request, `/{app}/{profiles}`. */
  app: string
  /** A git branch or tag, appended as the last path segment when set. */
  label?: string
  /** Tried in order until one answers. */
  baseURLs: string[]
  headers?: Record<string, string>
  /** Sent as `Authorization: Bearer <token>`. Wins over `basicAuth`. */
  authToken?: string
  basicAuth?: { username: string; password: string }
  dispatcher?: RequestInit['dispatcher']
  /** Called before every attempt, retries included: the place for a token refresh or a request signature. */
  beforeRequest?: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>
  /** Attempts per URL after the first, for a network error or a 5xx. A 4xx is not retried. Defaults to 3. */
  retries?: number
  /** Budget of one HTTP call. Defaults to 10 000 ms. */
  timeoutMs?: number
  /** Start-up proceeds without the server when it cannot be reached; the source is retried like any live one. */
  optional?: boolean
  /** Reload on this period. Without it the source reloads only when asked. */
  pollInterval?: Duration
  /** Adds `config.client.version` and `config.client.state` from the server's answer. Defaults to `true`. */
  includeMetadata?: boolean
  /** Defaults to `spring-cloud-config`. */
  name?: string
}

interface ConfigServerResponse {
  name: string
  profiles: string[]
  label?: string
  version?: string
  state?: string
  propertySources?: { name: string; source: Record<string, unknown> }[]
}

/**
 * Configuration from a Spring Cloud Config server. The server's property sources become layers: the one the
 * server lists first wins. Keys are expanded, so `server.port` and `servers[0].host` address a tree.
 */
export class SpringCloudConfigSource implements ConfigSource {
  readonly name: string
  readonly live = true
  readonly optional: boolean
  readonly pollInterval: Duration | undefined
  readonly #options: SpringCloudConfigSourceOptions & { retries: number; timeoutMs: number; includeMetadata: boolean }

  constructor(options: SpringCloudConfigSourceOptions) {
    this.name = options.name ?? 'spring-cloud-config'
    this.optional = options.optional ?? false
    this.pollInterval = options.pollInterval
    this.#options = {
      ...options,
      baseURLs: options.baseURLs.map(url => url.replace(/\/+$/, '')),
      retries: options.retries ?? 3,
      timeoutMs: options.timeoutMs ?? 10_000,
      includeMetadata: options.includeMetadata ?? true,
    }
  }

  /**
   * @throws ErrConfig `ERR_CONFIG_SOURCE` when no server answered, with the last failure as the cause.
   */
  async load(context: ConfigLoadContext): Promise<readonly ConfigLayer[]> {
    // No active profile sends `default`, as a Spring config client does when it has none.
    const profile = context.profiles.map(p => encodeURIComponent(p)).join(',') || 'default'
    const { app, label } = this.#options
    const path = `/${encodeURIComponent(app)}/${profile}${label === undefined ? '' : `/${encodeURIComponent(label)}`}`

    let lastError: unknown

    for (const baseURL of this.#options.baseURLs) {
      try {
        return this.#layers(await this.#fetch(baseURL + path, context.signal))
      } catch (error) {
        if (context.signal.aborted) {
          throw error
        }
        lastError = error
      }
    }

    throw new ErrConfig(
      `Cannot load config source "${this.name}": ${messageOf(lastError)}`,
      'ERR_CONFIG_SOURCE',
      lastError,
    )
  }

  async #fetch(url: string, signal: AbortSignal): Promise<ConfigServerResponse> {
    const { retries, timeoutMs, dispatcher, beforeRequest } = this.#options
    let lastError: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      // Whatever failed, a dropped connection or a 5xx, the server is given time before it is asked again.
      if (attempt > 0) {
        await delay(pollDelay(RETRY_DELAY_MS, attempt - 1), undefined, { signal, ref: false })
      }

      const base: RequestInit = {
        method: 'GET',
        headers: this.#requestHeaders(),
        ...(dispatcher === undefined ? {} : { dispatcher }),
      }

      // Outside the timeout: a token refresh must not eat the budget of the HTTP call.
      const init = beforeRequest === undefined ? base : await beforeRequest(url, base)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.any([controller.signal, signal]) })
      } catch (error) {
        // The store gave up on this load, or the call ran out of time: neither is worth another attempt.
        if (signal.aborted || isAbortError(error)) {
          throw error
        }
        lastError = error
        continue
      } finally {
        clearTimeout(timeout)
      }

      if (response.ok) {
        return (await response.json()) as ConfigServerResponse
      }

      const failure = new Error(`the config server answered ${response.status} ${response.statusText} for ${url}`)
      if (response.status < 500) {
        throw failure
      }
      lastError = failure
    }

    throw lastError
  }

  #requestHeaders(): Record<string, string> {
    const { headers: fixed, authToken, basicAuth } = this.#options
    const headers: Record<string, string> = { ...fixed }

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`
    } else if (basicAuth !== undefined) {
      headers['Authorization'] = `Basic ${btoa(`${basicAuth.username}:${basicAuth.password}`)}`
    }

    return headers
  }

  /** The server lists its highest-precedence source first. Merging is later-wins, so the list is reversed. */
  #layers(response: ConfigServerResponse): ConfigLayer[] {
    const layers = (response.propertySources ?? []).toReversed().map(remote => {
      const name = `spring-cloud-config:${remote.name}`
      return { name, data: expandKeys((remote.source ?? {}) as Record<string, ConfigValue>, name) }
    })

    if (this.#options.includeMetadata && (response.version !== undefined || response.state !== undefined)) {
      const client: Record<string, string> = {}
      if (response.version !== undefined) {
        client.version = response.version
      }
      if (response.state !== undefined) {
        client.state = response.state
      }
      layers.push({ name: 'spring-cloud-config:metadata', data: { config: { client } } as ConfigObject })
    }

    return layers
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
