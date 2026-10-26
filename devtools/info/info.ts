import { createRequire } from 'node:module'
import { hostname } from 'node:os'

import { RunInfoContrib } from '@caffeinejs/application'
import type { ConfigStore } from '@caffeinejs/application/config'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import type { Container } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'
import { Second } from '@caffeinejs/std/duration'

import type { ToolInfo } from '../tool.js'

/** What the application is and what it runs on. */
export const InfoSchema = $t.Object({
  application: $t.Object({
    /** `caffeine.name`; `''` when the configuration sets none. */
    name: $t.String(),
    profiles: $t.Array($t.String()),
    /** What each feature reported it runs, as `RunInfo.contrib` holds it. */
    contrib: $t.Array($t.Object({ source: $t.String() }, { additionalProperties: true })),
  }),
  runtime: $t.Object({
    /** The `@caffeinejs/application` version; absent when a bundle left the manifest behind. */
    caffeine: $t.Optional($t.String()),
    node: $t.String(),
    platform: $t.String(),
    arch: $t.String(),
    pid: $t.Integer(),
    hostname: $t.String(),
    nodeEnv: $t.Optional($t.String()),
    /** An ISO 8601 timestamp. */
    startedAt: $t.String(),
    /** A duration, in milliseconds. */
    uptime: $t.Number(),
  }),
})

export type InfoRecord = InferSchema<typeof InfoSchema>

export const infoTool: ToolInfo = {
  id: 'info',
  title: 'Info',
  description: 'The application, its profiles and features, and the process it runs in',
}

/**
 * The application's name, profiles and what its features run, and the process it runs in.
 *
 * - `GET /info`
 */
export function infoRouter(container: Container, store: ConfigStore<unknown>) {
  return new Router('/info')
    .get('')
    .schema({ response: { 200: InfoSchema } })
    .handler((): InfoRecord => {
      const name = store.explain('caffeine.name').layers[0]?.value
      const uptime = Math.floor(process.uptime() * Second)

      return {
        application: {
          name: typeof name === 'string' ? name : '',
          profiles: [...store.profiles],
          contrib: [...(container.getOptional(RunInfoContrib)?.entries ?? [])],
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
    })
}

function caffeineVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@caffeinejs/application/package.json') as { version: string }).version
  } catch {
    return undefined
  }
}
