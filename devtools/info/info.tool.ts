import { createRequire } from 'node:module'
import { hostname } from 'node:os'

import { RunInfoContrib } from '@caffeinejs/application'
import type { ConfigStore } from '@caffeinejs/application/config'
import type { Container } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'

import type { ToolInfo } from '../tool.js'
import type { InfoRecord } from './info.schema.js'

export const infoTool: ToolInfo = {
  id: 'info',
  title: 'Info',
  description: 'The application, its profiles and features, and the process it runs in',
}

/** Reads what the application is and the process it runs in. */
export class InfoTool {
  readonly #container: Container
  readonly #store: ConfigStore<unknown>

  constructor(container: Container, store: ConfigStore<unknown>) {
    this.#container = container
    this.#store = store
  }

  read(): InfoRecord {
    const name = this.#store.explain('caffeine.name').layers[0]?.value
    const uptime = Math.floor(process.uptime() * Second)

    return {
      application: {
        name: typeof name === 'string' ? name : '',
        profiles: [...this.#store.profiles],
        contrib: [...(this.#container.getOptional(RunInfoContrib)?.entries ?? [])],
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
