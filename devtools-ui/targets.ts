import { token } from '@caffeinejs/di'
import { newClient, type FetchyClient } from '@caffeinejs/fetchy'
import { errMessage } from '@caffeinejs/std/framework/err'

import type { ApplicationConfig, DevToolsUIConfig } from './config.js'
import { ErrDevToolsUIConfiguration } from './errors.js'
import { headers, headersOf, timeout } from './interceptors.js'
import { BindingsAPI } from './slices/bindings/client.js'
import { ConfigurationAPI } from './slices/configuration/client.js'
import { SliceAPI } from './slices/generic/client.js'
import { GraphAPI } from './slices/graph/client.js'
import { HealthAPI } from './slices/health/client.js'
import { IndexAPI } from './slices/index/client.js'
import { InfoAPI } from './slices/info/client.js'
import { RoutesAPI } from './slices/routes/client.js'

// Letters, digits, "_" and "-": the name is a path segment of every page, and `/_ui/` stays the UI's own.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DEFAULT_TIMEOUT_MS = 5000

/** One configured application, and a client for each of its slices. */
export interface Target {
  readonly name: string
  readonly index: IndexAPI
  readonly bindings: BindingsAPI
  readonly graph: GraphAPI
  readonly routes: RoutesAPI
  readonly health: HealthAPI
  readonly info: InfoAPI
  readonly configuration: ConfigurationAPI
  readonly slice: SliceAPI
}

/** Every configured application, in the order the configuration lists them. */
export class Targets {
  readonly #targets: ReadonlyMap<string, Target>
  readonly #clients: readonly FetchyClient[]

  private constructor(targets: ReadonlyMap<string, Target>, clients: readonly FetchyClient[]) {
    this.#targets = targets
    this.#clients = clients
  }

  /**
   * @throws ErrDevToolsUIConfiguration for a name that is not letters, digits, "_" and "-", a URL that is not an
   *   absolute http or https URL or carries credentials, a query or a fragment, and credentials set two ways.
   */
  static from(applications: DevToolsUIConfig['applications']): Targets {
    const entries = Object.entries(applications)

    // Every application is checked before any client is built, so a refusal leaves nothing open.
    for (const [name, application] of entries) {
      check(name, application)
    }

    const targets = new Map<string, Target>()
    const clients: FetchyClient[] = []

    for (const [name, application] of entries) {
      const client = newClient()
        .baseURL(application.url)
        .addInterceptor(timeout(application.timeout ?? DEFAULT_TIMEOUT_MS))
        .addInterceptor(headers(headersOf(application)))
        .build()

      clients.push(client)
      targets.set(name, {
        name,
        index: client.create(IndexAPI),
        bindings: client.create(BindingsAPI),
        graph: client.create(GraphAPI),
        routes: client.create(RoutesAPI),
        health: client.create(HealthAPI),
        info: client.create(InfoAPI),
        configuration: client.create(ConfigurationAPI),
        slice: client.create(SliceAPI),
      })
    }

    return new Targets(targets, clients)
  }

  get(name: string): Target | undefined {
    return this.#targets.get(name)
  }

  all(): Target[] {
    return [...this.#targets.values()]
  }

  async close(): Promise<void> {
    await Promise.all(this.#clients.map(client => client.close()))
  }
}

// Never repeats the URL: it may carry what it must not.
/** Where the UI's container holds its {@link Targets}. */
export const kTargets = token<Targets>(Symbol('caffeine.devtools-ui.targets'))

function check(name: string, application: ApplicationConfig): void {
  const key = `applications.${name}`

  if (!NAME.test(name)) {
    refuse(
      `Cannot read application "${name}": the name is not letters, digits, "_" and "-"`,
      `Rename "${key}" to letters, digits, "_" and "-", starting with a letter or a digit`,
    )
  }

  if (!URL.canParse(application.url)) {
    refuse(
      `Cannot read application "${name}": "${key}.url" is not an absolute URL`,
      `Write "${key}.url" as the URL the application serves DevTools on, such as "http://127.0.0.1:9100/devtools"`,
    )
  }

  const url = new URL(application.url)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    refuse(
      `Cannot read application "${name}": "${key}.url" is not an http or https URL`,
      `Write "${key}.url" with "http://" or "https://"`,
    )
  }

  if (url.username !== '' || url.password !== '') {
    refuse(`Cannot read application "${name}": "${key}.url" carries credentials`, `Move them to "${key}.auth.basic"`)
  }

  if (url.search !== '' || url.hash !== '') {
    refuse(
      `Cannot read application "${name}": "${key}.url" has a query or a fragment`,
      `Drop them from "${key}.url": it names where the DevTools index answers`,
    )
  }

  const { basic, bearer } = application.auth ?? {}

  if (basic !== undefined && bearer !== undefined) {
    refuse(
      `Cannot read application "${name}": both "${key}.auth.basic" and "${key}.auth.bearer" are set`,
      'Keep the one the application authenticates DevTools with',
    )
  }

  const authorization = Object.keys(application.headers ?? {}).some(header => header.toLowerCase() === 'authorization')

  if ((basic !== undefined || bearer !== undefined) && authorization) {
    refuse(
      `Cannot read application "${name}": "${key}.auth" and an "authorization" header are both set`,
      `Remove the "authorization" header from "${key}.headers", or "${key}.auth"`,
    )
  }
}

function refuse(message: string, ...solutions: string[]): never {
  throw new ErrDevToolsUIConfiguration(
    errMessage(message)
      .solutions(...solutions)
      .reference('@caffeinejs/devtools-ui', ErrDevToolsUIConfiguration)
      .build(),
  )
}
