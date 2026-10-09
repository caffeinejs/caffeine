import type { WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { ConfigSource } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  configuration,
  type ConfigurationSliceBuilder,
  type DevToolsConfigEntry,
  type DevToolsConfigurationReport,
} from '../index.js'
import { get, target } from './fixtures.js'

const Schema = $t.Object({
  db: $t.Object({ host: $t.String(), password: $t.String(), url: $t.String() }),
  apiToken: $t.String(),
  signingKey: $t.String(),
  feature: $t.Object({ flag: $t.Boolean(), mode: $t.String() }),
  region: $t.String({ default: 'eu' }),
  hosts: $t.Array($t.String()),
})

const SECRETS = ['hunter2', 't0ken', 'k3y']

function definition(...extra: ConfigSource[]) {
  return newConfiguration(Schema)
    .sources(
      new InlineConfigSource({
        db: { host: 'db.internal', password: 'hunter2', url: 'postgres://app:hunter2@db.internal/app' },
        apiToken: 't0ken',
        signingKey: 'k3y',
        hosts: ['a.internal', 'b.internal'],
      }),
      new EnvConfigSource({ prefix: 'APP_', env: { APP_FEATURE__FLAG: 'true', APP_FEATURE__MODE: 'fast' } }),
      ...extra,
    )
    .build().config
}

describe('the configuration slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function fetchReport(
    configure?: (c: ConfigurationSliceBuilder) => ConfigurationSliceBuilder,
    ...extra: ConfigSource[]
  ): Promise<{ text: string; report: DevToolsConfigurationReport }> {
    app ??= target({ config: definition(...extra), devtools: d => d.slices(configuration(configure)) })
    await app.bootstrap()

    const text = await (await get(app, '/devtools/configuration')).text()
    return { text, report: JSON.parse(text) as DevToolsConfigurationReport }
  }

  const entry = (report: DevToolsConfigurationReport, path: string): DevToolsConfigEntry | undefined =>
    report.entries.find(candidate => candidate.path === path)

  it('reports every path with the layer and the origin that set it', async () => {
    const { report } = await fetchReport()

    expect(entry(report, 'db.host')).toEqual({ path: 'db.host', layer: 'inline', origin: 'inline' })
    expect(entry(report, 'feature.flag')).toEqual({
      path: 'feature.flag',
      layer: 'env:APP_',
      origin: 'env:APP_FEATURE__FLAG',
    })
    // A source replaces an array whole, so it is one entry, at its own path.
    expect(entry(report, 'hosts')).toEqual({ path: 'hosts', layer: 'inline', origin: 'inline' })
    // No layer: the schema's default.
    expect(entry(report, 'region')).toEqual({ path: 'region' })

    expect(report.revision).toBe(0)
    expect(report.sources.map(source => [source.name, source.consecutiveFailures])).toEqual([
      ['inline', 0],
      ['env:APP_', 0],
    ])
  })

  // The configuration holds the application's secrets as they are, so nothing is sent unless asked for.
  it('withholds every value unless showValues() is called', async () => {
    const { text, report } = await fetchReport()

    expect(report.showsValues).toBe(false)
    for (const value of [...SECRETS, 'db.internal', 'a.internal']) {
      expect(text).not.toContain(value)
    }
    for (const sent of report.entries) {
      expect(sent, sent.path).not.toHaveProperty('value')
      expect(sent, sent.path).not.toHaveProperty('masked')
    }
  })

  it('sends values with showValues(), still withholding what looks like a secret', async () => {
    const { text, report } = await fetchReport(c => c.showValues())

    expect(report.showsValues).toBe(true)
    expect(entry(report, 'db.host')?.value).toBe('db.internal')
    expect(entry(report, 'feature.flag')?.value).toBe(true)
    expect(entry(report, 'hosts')?.value).toEqual(['a.internal', 'b.internal'])

    for (const path of ['db.password', 'apiToken', 'signingKey']) {
      expect(entry(report, path), path).toEqual({ path, layer: 'inline', origin: 'inline', masked: true })
    }

    // A URL's credentials are replaced, the rest of it kept.
    expect(entry(report, 'db.url')?.value).toBe('postgres://***@db.internal/app')

    for (const secret of SECRETS) {
      expect(text).not.toContain(secret)
    }
  })

  // A global pattern keeps its `lastIndex` between `test()` calls: left as given, it would miss the path right after
  // one it matched, `feature.mode` after `feature.flag` here.
  it('withholds what mask(...) names, every path and on every request', async () => {
    const { report: first } = await fetchReport(c => c.showValues().mask(/^feature\./g))
    const { report: second } = await fetchReport()

    for (const report of [first, second]) {
      expect(entry(report, 'feature.flag')?.masked).toBe(true)
      expect(entry(report, 'feature.mode')?.masked).toBe(true)
      expect(entry(report, 'region')?.value).toBe('eu')
    }
  })

  // An optional source the application started without is the one a reader most needs to see.
  it('reports a source that failed to load, with its failure as a message', async () => {
    const remote: ConfigSource = {
      name: 'remote',
      optional: true,
      load: () => {
        throw new Error('remote configuration unreachable')
      },
    }

    const { report } = await fetchReport(undefined, remote)

    expect(report.sources.find(source => source.name === 'remote')).toMatchObject({
      consecutiveFailures: 1,
      lastError: expect.stringMatching(/^Cannot load config source "remote": remote configuration unreachable/),
    })
  })
})
