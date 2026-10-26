import { createRequire } from 'node:module'
import { hostname } from 'node:os'

import { RunInfoContrib, type RunInfoEntry } from '@caffeinejs/application'
import type { ConfigStore } from '@caffeinejs/application/config'
import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import type { Container } from '@caffeinejs/di'
import { Second, type Duration } from '@caffeinejs/std/duration'

/** What the application is and what it runs on. */
export interface InfoRecord {
  readonly application: {
    /** `caffeine.name`; `''` when the configuration sets none. */
    readonly name: string
    readonly profiles: readonly string[]
    /** What each feature reported it runs, as `RunInfo.contrib` holds it. */
    readonly contrib: readonly RunInfoEntry[]
  }
  readonly runtime: {
    /** The `@caffeinejs/application` version; `undefined` when a bundle left the manifest behind. */
    readonly caffeine: string | undefined
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly pid: number
    readonly hostname: string
    readonly nodeEnv: string | undefined
    /** An ISO 8601 timestamp. */
    readonly startedAt: string
    readonly uptime: Duration
  }
}

/**
 * The application's name, profiles and what its features run, and the process it runs in.
 *
 * - `GET /info`
 */
export class InfoTool extends DevTool {
  readonly id = 'info'
  readonly title = 'Info'
  readonly description = 'The application, its profiles and features, and the process it runs in'
  readonly operations: readonly DevToolOperation[]

  readonly #container: Container
  readonly #store: ConfigStore<unknown>

  constructor(container: Container, store: ConfigStore<unknown>) {
    super()
    this.#container = container
    this.#store = store
    this.operations = [{ method: 'GET', path: '', handle: () => this.#info() }]
  }

  #info(): InfoRecord {
    const name = this.#store.explain('caffeine.name').layers[0]?.value
    const uptime = Math.floor(process.uptime() * Second)

    return {
      application: {
        name: typeof name === 'string' ? name : '',
        profiles: [...this.#store.profiles],
        contrib: this.#container.getOptional(RunInfoContrib)?.entries ?? [],
      },
      runtime: {
        caffeine: caffeineVersion(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        hostname: hostname(),
        nodeEnv: process.env.NODE_ENV,
        startedAt: new Date(Date.now() - uptime).toISOString(),
        uptime,
      },
    }
  }
}

function caffeineVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@caffeinejs/application/package.json') as { version: string }).version
  } catch {
    return undefined
  }
}
