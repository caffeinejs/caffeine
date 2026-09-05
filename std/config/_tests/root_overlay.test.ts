import { kSelfRefresh } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ConfigDefinition } from '../definition.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { ConfigPriority } from '../sources.js'
import type { ConfigProvider, ConfigValue } from '../types.js'

/**
 * Every registered slice's values belong in the root tree, whatever the application's schema declares.
 *
 * Without this, declaring a schema *deletes* the framework's configuration from `ctx.config` and from
 * `$i.value(c => ...)`: slices read the materialized tree, the root handle reads the validated one, and
 * validation drops every key the schema does not name. The suite below is about what the root handle sees, so
 * every assertion reads the handle rather than a slice.
 */
describe('root tree overlay', () => {
  const widgetSchema = $t.Object({ size: $t.Number({ default: 1 }) })

  async function resolve(definition: ConfigDefinition, extra: readonly ConfigProvider[] = []) {
    definition.sources.addAll(extra, ConfigPriority.ENV)

    return bootstrapConfig({
      sources: definition.sources,
      schema: definition.schema,
      slices: definition.slices,
      context: { app: 'test', profiles: ['default'] },
    })
  }

  it('carries a namespace the application schema never declared', async () => {
    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ catalog: $t.Object({ pageSize: $t.Number({ default: 25 }) }, { default: {} }) })
    definition.slice(['widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ widget: { size: 7 } })])

    expect(validated).toEqual({ catalog: { pageSize: 25 }, widget: { size: 7 } })
  })

  it('places a relocated slice where it actually resolved', async () => {
    const definition = new ConfigDefinition()
    definition.slice(['app', 'widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ app: { widget: { size: 3 } } })])

    expect(validated).toEqual({ app: { widget: { size: 3 } } })
  })

  // Authentication registers `auth` alongside `auth.schemes.*`, and the parent's schema declares none of the
  // children. A parent written after its child would erase it, so ordering cannot be left to registration.
  it('keeps a parent and the slices nested inside it, in either registration order', async () => {
    const parentSchema = $t.Object({ scheme: $t.String({ default: 'jwt' }) })
    const childSchema = $t.Object({ secret: $t.String({ default: 's3cret' }) })

    for (const childFirst of [false, true]) {
      const definition = new ConfigDefinition()

      if (childFirst) {
        definition.slice(['auth', 'schemes', 'jwt'], childSchema)
        definition.slice(['auth'], parentSchema)
      } else {
        definition.slice(['auth'], parentSchema)
        definition.slice(['auth', 'schemes', 'jwt'], childSchema)
      }

      const { validated } = await resolve(definition)

      expect(validated).toEqual({ auth: { scheme: 'jwt', schemes: { jwt: { secret: 's3cret' } } } })
    }
  })

  // A slice spanning the whole tree would replace the application's own rather than sit inside it.
  it('skips a slice registered at the root', async () => {
    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ catalog: $t.String({ default: 'app' }) })
    definition.slice([], $t.Object({ catalog: $t.String({ default: 'slice' }) }))

    const { validated } = await resolve(definition)

    expect(validated).toEqual({ catalog: 'app' })
  })

  it('does not overlay a slice that failed to resolve', async () => {
    const definition = new ConfigDefinition()
    definition.slice(['widget'], $t.Object({ size: $t.Number() }))

    const { validated, failures } = await resolve(definition, [
      new InlineConfigProvider({ widget: { size: 'not-a-number' } }),
    ])

    expect(failures).toHaveLength(1)
    expect(validated).toEqual({ widget: { size: 'not-a-number' } })
  })

  // Under `passthroughConfigSchema` the validated tree *is* the materialized one — the standard-schema branch
  // hands its input straight back — and that object is what every slice read from.
  it('leaves the materialized tree alone', async () => {
    const definition = new ConfigDefinition()
    definition.slice(['widget'], widgetSchema)

    const { materialized, validated } = await resolve(definition)

    expect(materialized).toEqual({})
    expect(validated).toEqual({ widget: { size: 1 } })
  })

  // The application declared the namespace, so its value stands; the slice fills in only what it left out.
  // The two cannot disagree, because the schema's defaults were published into the tree the slice resolved from.
  it('lets the application keep what it declared and fills in the rest', async () => {
    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ widget: $t.Object({ size: $t.Number({ default: 5 }) }, { default: {} }) })
    definition.slice(['widget'], $t.Object({ size: $t.Number({ default: 1 }), label: $t.String({ default: 'w' }) }))

    const { validated } = await resolve(definition)

    expect(validated).toEqual({ widget: { size: 5, label: 'w' } })
  })

  // The overlay runs inside `bootstrapConfig`, which a refresh re-enters — so a reloaded slice's new values
  // have to reach the root tree too, not only the slice's own holder.
  it('survives a refresh', async () => {
    let data: Record<string, ConfigValue> = { widget: { size: 1 } }
    const mutable: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: ctx => new InlineConfigProvider(data).load(ctx),
    }

    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ catalog: $t.String({ default: 'app' }) })
    definition.slice(['widget'], widgetSchema)
    definition.sources.add(mutable, ConfigPriority.USER)

    const shard = await definition.bootstrap()
    expect(shard.validated).toEqual({ catalog: 'app', widget: { size: 1 } })

    data = { widget: { size: 42 } }
    await shard[kSelfRefresh]()

    expect(shard.validated).toEqual({ catalog: 'app', widget: { size: 42 } })
  })

  it('overlays under a foreign Standard Schema too', async () => {
    const definition = new ConfigDefinition()
    definition.schema = z.object({ catalog: z.object({ pageSize: z.coerce.number() }) })
    definition.slice(['widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ catalog: { pageSize: 25 } })])

    expect(validated).toEqual({ catalog: { pageSize: 25 }, widget: { size: 1 } })
  })
})
