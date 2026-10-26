import { newConfiguration } from '@caffeinejs/application'
import { loadConfig, type ConfigSchema, type ConfigSource, type ConfigStore } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { testClient } from '@caffeinejs/testing/http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configRouter, ConfigTool, type ConfigToolOptions } from './config.js'
import { maskCredentials } from './redact.js'

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

describe('configRouter', () => {
  const stores: Array<ConfigStore<unknown>> = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(stores.splice(0).map(store => store.close()))
  })

  /** The configuration tool over a store loaded from `sources`, read through its router. */
  async function client(
    options: Partial<ConfigToolOptions> = {},
    shape: ConfigSchema = schema,
    ...sources: ConfigSource[]
  ) {
    const given =
      sources.length === 0 ? [new InlineConfigSource(values), new EnvConfigSource({ prefix: 'DT_' })] : sources
    const store = await loadConfig(
      newConfiguration(shape)
        .sources(...given)
        .build().config,
      { start: false },
    )
    stores.push(store)

    return testClient(configRouter(new ConfigTool(store, { showValues: false, redact: [], ...options })))
  }

  type Client = Awaited<ReturnType<typeof client>>

  async function properties(config: Client) {
    return (await config.config.properties.get()).json()
  }

  async function property(config: Client, path: string) {
    const res = await config.config.properties({ path }).get()

    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }

    return res.json()
  }

  it('lists every path and where it came from, and no value, unless told to show them', async () => {
    vi.stubEnv('DT_CATALOG__PAGE_SIZE', '50')
    await using config = await client()

    const listed = await properties(config)

    expect(listed.find(property => property.path === 'catalog.pageSize')).toEqual({
      path: 'catalog.pageSize',
      origin: 'env:DT_CATALOG__PAGE_SIZE',
      secret: false,
    })
    expect(listed.every(property => !('value' in property))).toBe(true)
    expect(JSON.stringify(listed)).not.toMatch(/hunter2|p4ss|whsec|tok"|s3cret/)
  })

  it('masks every kind of secret once values are shown', async () => {
    await using config = await client({ showValues: true, redact: ['stripe.*'] })

    const byPath = Object.fromEntries((await properties(config)).map(entry => [entry.path, entry]))

    expect(byPath['catalog.pageSize']).toMatchObject({ value: 25, secret: false })
    // `$t.Secret`, a pattern, a segment naming a secret
    expect(byPath['db.pass']).toMatchObject({ value: '******', secret: true })
    expect(byPath['stripe.webhook']).toMatchObject({ value: '******', secret: true })
    expect(byPath['mail.smtpToken']).toMatchObject({ value: '******', secret: true })
    // A URL keeps its user and host and loses its password.
    expect(byPath['db.url']).toMatchObject({ value: 'postgres://app:******@db:5432/pets', secret: false })
    expect(byPath['mail.hosts']).toMatchObject({ value: ['smtp://mailer:******@mx1', 'smtp://mx2'] })
  })

  it('masks everything under a path a "**" pattern names, at any depth', async () => {
    await using config = await client({ showValues: true, redact: ['mail.**'] })

    const byPath = Object.fromEntries((await properties(config)).map(entry => [entry.path, entry]))

    expect(byPath['mail.hosts']).toMatchObject({ value: '******', secret: true })
    expect(byPath['catalog.pageSize']).toMatchObject({ value: 25, secret: false })
  })

  it('masks a secret inside an array of objects, a record of secrets, and every URL password in a value', async () => {
    const leaky = $t.Object({
      users: $t.Array($t.Object({ name: $t.String(), pin: $t.Secret($t.String()), password: $t.String() })),
      hooks: $t.Record($t.String(), $t.Secret($t.String())),
      cache: $t.Object({ nodes: $t.String(), dsn: $t.String(), replica: $t.String() }),
    })
    const source = new InlineConfigSource({
      users: [{ name: 'ann', pin: '1234', password: 'pw-ann' }],
      hooks: { stripe: 'whsec_1' },
      cache: {
        nodes: 'redis://:first@h1,redis://:second@h2',
        dsn: 'postgres://u:p/ss@db/x',
        replica: 'postgres://u:p@ss@replica/x',
      },
    })
    await using config = await client({ showValues: true }, leaky, source)

    const body = JSON.stringify(await properties(config))

    expect(body).not.toMatch(/1234|pw-ann|whsec_1|first|second|p\/ss|p@ss/)
    expect(body).toContain('ann')
    expect(body).toContain('redis://:******@h1,redis://:******@h2')
    expect(body).toContain('postgres://u:******@db/x')
    expect(body).toContain('postgres://u:******@replica/x')
  })

  it('masks the secret member of a tuple', async () => {
    await using config = await client(
      { showValues: true },
      $t.Object({ pair: $t.Tuple([$t.Secret($t.String()), $t.String()]) }),
      new InlineConfigSource({ pair: ['hunter2', 'public'] }),
    )

    expect(await properties(config)).toEqual([
      { path: 'pair', origin: 'inline', secret: false, value: ['******', 'public'] },
    ])
  })

  it('masks the secrets of text a codec decoded, in each layer that set it', async () => {
    // A layer holds the text as the source gave it, not the value the codec decoded from it.
    vi.stubEnv('DT_USERS', '[{"name":"ann","pin":"1234"}]')
    vi.stubEnv('DT_TAGS', 'tag-a,tag-b')
    const encoded = $t.Object({
      users: $t.JSON($t.Array($t.Object({ name: $t.String(), pin: $t.Secret($t.String()) }))),
      tags: $t.List($t.Secret($t.String())),
    })
    await using config = await client({ showValues: true }, encoded, new EnvConfigSource({ prefix: 'DT_' }))

    const users = await property(config, 'users')
    const tags = await property(config, 'tags')

    expect(users.layers).toEqual([
      { layer: 'env:DT_', origin: 'env:DT_USERS', value: [{ name: 'ann', pin: '******' }] },
    ])
    // Text that is not JSON gives no way to tell where its secrets sit, so it is masked whole.
    expect(tags.layers).toEqual([{ layer: 'env:DT_', origin: 'env:DT_TAGS', value: '******' }])
    expect(JSON.stringify([users, tags])).not.toMatch(/1234|tag-a|tag-b/)
  })

  it('masks a URL password holding "@" whole: the host starts after the last one', () => {
    expect(maskCredentials('postgres://u:p@ss@db/x')).toBe('postgres://u:******@db/x')
    expect(maskCredentials('mongodb://admin:p@ssw0rd@db.internal:27017/app')).toBe(
      'mongodb://admin:******@db.internal:27017/app',
    )
    expect(maskCredentials('redis://:first@h1,redis://:second@h2')).toBe('redis://:******@h1,redis://:******@h2')
    expect(maskCredentials('see https://u:p@ss@h/a?next=x@y and more')).toBe(
      'see https://u:******@h/a?next=x@y and more',
    )
  })

  it('masks in linear time, so a crafted value cannot stall the devtools', () => {
    // Each start position used to rescan the rest of the text: quadratic, and minutes on this input.
    const crafted = 'a://:'.repeat(200_000)

    expect(maskCredentials(crafted)).toBe(crafted)
    expect(maskCredentials(`${'a'.repeat(200_000)}://u:p@h`)).toBe(`${'a'.repeat(200_000)}://u:******@h`)
  })

  it('answers one value with every layer that set it, masked the same way', async () => {
    vi.stubEnv('DT_DB__PASS', 'from-env')
    await using config = await client({ showValues: true })

    const detail = await property(config, 'db.pass')

    expect(detail.layers).toEqual([
      { layer: 'env:DT_', origin: 'env:DT_DB__PASS', value: '******' },
      { layer: 'inline', origin: 'inline', value: '******' },
    ])
    expect(JSON.stringify(detail)).not.toMatch(/from-env|p4ss/)
  })

  it('answers 404 for a path the configuration does not hold', async () => {
    await using config = await client()

    expect((await config.config.properties({ path: 'db.nope' }).get()).status).toBe(404)
  })

  it('lists the sources it was loaded from', async () => {
    await using config = await client()

    const sources = await (await config.config.sources.get()).json()

    expect(sources.map(source => source.name)).toEqual(['inline', 'env:DT_'])
    expect(sources.every(source => source.consecutiveFailures === 0)).toBe(true)
  })

  it('refuses a redact pattern that is not a dotted path', async () => {
    const store = await loadConfig(newConfiguration(schema).source(new InlineConfigSource(values)).build().config)
    stores.push(store)

    expect(() => new ConfigTool(store, { showValues: true, redact: ['stripe..x'] })).toThrow(
      expect.objectContaining({ code: 'ERR_DEVTOOLS_CONFIGURATION' }),
    )
  })
})
