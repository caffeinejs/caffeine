import type { ConfigEntry, ConfigProvider, ConfigValue, PropertySource, ResolutionContext } from '../config.js'
import { ErrConfig } from '../errors.js'

export interface SpringCloudConfigProviderOptions {
  /** The application name — the first path segment of the config-server request (`/{app}/{profiles}`). */
  app: string
  /** The config-server label (a git branch or tag), appended as the trailing path segment when set. */
  label?: string
  baseURLs: string[]
  headers?: Record<string, string>
  authToken?: string
  basicAuth?: { username: string; password: string }
  dispatcher?: RequestInit['dispatcher']
  beforeRequest?: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>
  retries?: number
  timeoutMs?: number
  optional?: boolean
  includeMetadata?: boolean
}

interface ResolvedOptions {
  app: string
  label?: string
  baseURLs: string[]
  headers: Record<string, string>
  authToken: string
  basicAuth?: { username: string; password: string }
  dispatcher?: RequestInit['dispatcher']
  beforeRequest?: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>
  retries: number
  timeoutMs: number
  optional: boolean
  includeMetadata: boolean
}

interface SCCResponse {
  name: string
  profiles: string[]
  label?: string
  version?: string
  state?: string
  propertySources?: Array<{ name: string; source: Record<string, unknown> }>
}

export class SpringCloudConfigProvider implements ConfigProvider {
  readonly id = 'spring-cloud-config'
  // A config server is the reason refresh exists. No `revision()`: knowing whether it changed means asking it,
  // which is the same call as reloading.
  readonly reloadable = true
  readonly #options: ResolvedOptions

  constructor(options: SpringCloudConfigProviderOptions) {
    this.#options = {
      app: options.app,
      label: options.label,
      baseURLs: options.baseURLs.map(u => u.replace(/\/+$/, '')),
      headers: options.headers ?? {},
      authToken: options.authToken ?? '',
      basicAuth: options.basicAuth,
      dispatcher: options.dispatcher,
      beforeRequest: options.beforeRequest,
      retries: options.retries ?? 3,
      timeoutMs: options.timeoutMs ?? 10_000,
      optional: options.optional ?? false,
      includeMetadata: options.includeMetadata ?? true,
    }
  }

  async load(ctx: ResolutionContext): Promise<PropertySource[]> {
    const { app, label } = this.#options
    // No active profile falls back to `default`, the segment a Spring config client sends when it has none.
    const profile = ctx.profiles.map(p => encodeURIComponent(p)).join(',') || 'default'
    const labelSegment = label ? `/${encodeURIComponent(label)}` : ''
    const path = `/${encodeURIComponent(app)}/${profile}${labelSegment}`

    let lastError: unknown

    for (const baseURL of this.#options.baseURLs) {
      try {
        const payload = await this.#fetch(baseURL + path)
        return this.#mapResponse(payload, profile, label)
      } catch (err) {
        lastError = err
      }
    }

    if (this.#options.optional) {
      return []
    }
    throw new ErrConfig(`Config provider "${this.id}" failed to load`, 'ERR_CONFIG_PROVIDER', lastError)
  }

  async #fetch(url: string): Promise<SCCResponse> {
    let attempt = 0
    let lastErr: unknown

    while (attempt <= this.#options.retries) {
      // Build base init without signal — beforeRequest must not consume the HTTP timeout budget
      const baseInit: RequestInit = {
        method: 'GET',
        headers: this.#buildHeaders(),
        ...(this.#options.dispatcher ? { dispatcher: this.#options.dispatcher } : {}),
      }

      // Per-attempt interceptor: dynamic auth (token refresh, SigV4, etc.)
      const resolvedInit = this.#options.beforeRequest ? await this.#options.beforeRequest(url, baseInit) : baseInit

      // Timeout starts here — only the HTTP call counts against it
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs)

      let nonRetriable: Error | undefined

      try {
        const response = await fetch(url, { ...resolvedInit, signal: controller.signal })
        clearTimeout(timeout)

        if (!response.ok) {
          const err = new Error(`SCC responded ${response.status} ${response.statusText} for ${url}`)
          if (response.status < 500) {
            nonRetriable = err
          } else {
            lastErr = err
          }
        } else {
          return (await response.json()) as SCCResponse
        }
      } catch (err) {
        clearTimeout(timeout)
        if (isAbortError(err)) {
          throw err
        }
        if (lastErr !== err) {
          lastErr = err
        }
        if (attempt < this.#options.retries) {
          const delay = Math.min(100 * 2 ** attempt + Math.random() * 50, 2000)
          await sleep(delay)
        }
      }

      if (nonRetriable) {
        throw nonRetriable
      }

      attempt++
    }

    throw lastErr
  }

  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.#options.headers }
    if (this.#options.authToken) {
      headers['Authorization'] = `Bearer ${this.#options.authToken}`
    } else if (this.#options.basicAuth) {
      const { username, password } = this.#options.basicAuth
      headers['Authorization'] = `Basic ${btoa(`${username}:${password}`)}`
    }
    return headers
  }

  #mapResponse(payload: SCCResponse, profile: string, labelCtx?: string): PropertySource[] {
    const sources: PropertySource[] = []
    const remoteSources = payload.propertySources ?? []

    for (let i = 0; i < remoteSources.length; i++) {
      const remote = remoteSources[i]
      const entries = new Map<string, ConfigEntry>()

      for (const [key, value] of Object.entries(remote.source ?? {})) {
        entries.set(key, {
          key,
          value: value as ConfigValue,
          origin: `scc:${remote.name}`,
          profile,
          label: payload.label ?? labelCtx,
        })
      }

      sources.push({
        name: `spring-cloud-config:${remote.name}`,
        entries,
      })
    }

    if (this.#options.includeMetadata && (payload.version || payload.state)) {
      const meta = new Map<string, ConfigEntry>()
      const base = { profile, label: payload.label ?? labelCtx, origin: 'scc:metadata' }

      if (payload.version) {
        meta.set('config.client.version', { key: 'config.client.version', value: payload.version, ...base })
      }
      if (payload.state) {
        meta.set('config.client.state', { key: 'config.client.state', value: payload.state, ...base })
      }

      sources.unshift({
        name: 'spring-cloud-config:metadata',
        entries: meta,
      })
    }

    return sources
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
