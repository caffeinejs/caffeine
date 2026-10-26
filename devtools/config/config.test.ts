import { newConfiguration } from '@caffeinejs/application'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { devTools, type DevToolsPluginBuilder } from '../devtools.js'
import type { PropertyDetail, PropertyRecord, SourceRecord } from './config.js'

/**
 * The configuration as the devtools show it. A secret reaching this response is a leak to whoever can reach the
 * devtools, so values stay out unless asked for, and once asked for every way a secret is recognised must mask it.
 */

const schema = $t.Object({
  catalog: $t.Object({ pageSize: $t.Integer() }),
  db: $t.Object({ url: $t.String(), pass: $t.Secret($t.String()) }),
  stripe: $t.Object({ webhook: $t.String() }),
  mail: $t.Object({ smtpToken: $t.String(), hosts: $t.Array($t.String()) }),
})

const values = {
  catalog: { pageSize: 25 },
  db: { url: 'postgres://app:hunter2@db:5432/pets', pass: 'p4ss' },
  stripe: { webhook: 'whsec_123' },
  mail: { smtpToken: 'tok', hosts: ['smtp://mailer:s3cret@mx1', 'smtp://mx2'] },
}

describe('ConfigTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    app = undefined
  })

  async function boot(configure?: (d: DevToolsPluginBuilder) => void): Promise<void> {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource(values))
      .source(new EnvConfigSource({ prefix: 'DT_' }))
      .build().config

    app = createWebApplication({ container: new CaffeineIoC(), config: conf }).with(
      devTools(d => configure?.(d)),
    ) as WebApplication
    await app.bootstrap()
  }

  async function properties(): Promise<PropertyRecord[]> {
    return (await (await app!.fetch('/devtools/config/properties')).json()) as PropertyRecord[]
  }

  it('lists every path and where it came from, and no value, unless told to show them', async () => {
    vi.stubEnv('DT_CATALOG__PAGE_SIZE', '50')
    await boot()

    const listed = await properties()

    expect(listed.find(property => property.path === 'catalog.pageSize')).toEqual({
      path: 'catalog.pageSize',
      origin: 'env:DT_CATALOG__PAGE_SIZE',
      secret: false,
    })
    expect(listed.every(property => !('value' in property))).toBe(true)
    expect(JSON.stringify(listed)).not.toMatch(/hunter2|p4ss|whsec|tok"|s3cret/)
  })

  it('masks every kind of secret once values are shown', async () => {
    await boot(d => d.showConfigValues().redact('stripe.*'))

    const byPath = Object.fromEntries((await properties()).map(property => [property.path, property]))

    expect(byPath['catalog.pageSize']).toMatchObject({ value: 25, secret: false })
    // `$t.Secret`, a pattern, a segment naming a secret
    expect(byPath['db.pass']).toMatchObject({ value: '******', secret: true })
    expect(byPath['stripe.webhook']).toMatchObject({ value: '******', secret: true })
    expect(byPath['mail.smtpToken']).toMatchObject({ value: '******', secret: true })
    // A URL keeps its user and host and loses its password.
    expect(byPath['db.url']).toMatchObject({ value: 'postgres://app:******@db:5432/pets', secret: false })
    expect(byPath['mail.hosts']).toMatchObject({ value: ['smtp://mailer:******@mx1', 'smtp://mx2'] })
  })

  it('masks a secret inside an array of objects, a record of secrets, and every URL password in a value', async () => {
    const leaky = $t.Object({
      users: $t.Array($t.Object({ name: $t.String(), pin: $t.Secret($t.String()), password: $t.String() })),
      hooks: $t.Record($t.String(), $t.Secret($t.String())),
      cache: $t.Object({ nodes: $t.String(), dsn: $t.String() }),
    })
    const conf = newConfiguration(leaky)
      .source(
        new InlineConfigSource({
          users: [{ name: 'ann', pin: '1234', password: 'pw-ann' }],
          hooks: { stripe: 'whsec_1' },
          cache: { nodes: 'redis://:first@h1,redis://:second@h2', dsn: 'postgres://u:p/ss@db/x' },
        }),
      )
      .build().config
    app = createWebApplication({ container: new CaffeineIoC(), config: conf }).with(
      devTools(d => d.showConfigValues()),
    ) as WebApplication
    await app.bootstrap()

    const body = JSON.stringify(await properties())

    expect(body).not.toMatch(/1234|pw-ann|whsec_1|first|second|p\/ss/)
    expect(body).toContain('ann')
    expect(body).toContain('redis://:******@h1,redis://:******@h2')
    expect(body).toContain('postgres://u:******@db/x')
  })

  it('answers one value with every layer that set it, masked the same way', async () => {
    vi.stubEnv('DT_DB__PASS', 'from-env')
    await boot(d => d.showConfigValues())

    const detail = (await (await app!.fetch('/devtools/config/properties/db.pass')).json()) as PropertyDetail

    expect(detail.layers).toEqual([
      { layer: 'env:DT_', origin: 'env:DT_DB__PASS', value: '******' },
      { layer: 'inline', origin: 'inline', value: '******' },
    ])
    expect(JSON.stringify(detail)).not.toMatch(/from-env|p4ss/)
  })

  it('answers 404 for a path the configuration does not hold', async () => {
    await boot()

    expect((await app!.fetch('/devtools/config/properties/db.nope')).status).toBe(404)
  })

  it('lists the sources it was loaded from', async () => {
    await boot()

    const sources = (await (await app!.fetch('/devtools/config/sources')).json()) as SourceRecord[]

    expect(sources.map(source => source.name)).toEqual(['inline', 'env:DT_'])
    expect(sources.every(source => source.consecutiveFailures === 0)).toBe(true)
  })

  it('refuses a redact pattern that is not a dotted path', async () => {
    const conf = newConfiguration(schema).source(new InlineConfigSource(values)).build().config
    app = createWebApplication({ container: new CaffeineIoC(), config: conf }).with(
      devTools(d => d.redact('stripe..x')),
    ) as WebApplication

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_DEVTOOLS_CONFIGURATION' })
  })
})
