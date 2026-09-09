import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ConfigDefinition } from '../definition.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { ConfigPriority } from '../sources.js'
import type { ConfigProvider } from '../types.js'

/**
 * The resolved configuration object is the application's schema and nothing else.
 *
 * A feature never adds a field to it. Its settings appear there when the application put them there — declared
 * in its own schema and named by the feature's `.config(...)` selector — which is what keeps the shape of
 * `ctx.config` and of `$i.value(c => ...)` a property of the schema rather than of which features happen to be
 * installed.
 */
describe('the resolved root configuration', () => {
  interface WidgetConfig {
    size: number
  }

  const widgetSchema = $t.Object({ size: $t.Number({ default: 1 }) })

  async function resolve(definition: ConfigDefinition, extra: readonly ConfigProvider[] = []) {
    definition.sources.addAll(extra, ConfigPriority.ENV)

    return bootstrapConfig({
      sources: definition.sources,
      schema: definition.schema,
      slices: definition.slices,
      profiles: ['default'],
    })
  }

  it('drops a slice location the application schema never declared', async () => {
    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ catalog: $t.Object({ pageSize: $t.Number({ default: 25 }) }, { default: {} }) })
    const slice = definition.slice<WidgetConfig>(['widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ widget: { size: 7 } })])

    expect(validated).toEqual({ catalog: { pageSize: 25 } })
    // The feature still resolved, from the same tree — it simply is not part of the application's object.
    expect(slice.config.size).toBe(7)
  })

  it('keeps a location the application declared and pointed the feature at', async () => {
    const definition = new ConfigDefinition()
    definition.schema = $t.Object({ app: $t.Object({ widget: widgetSchema }, { default: {} }) })
    const slice = definition.slice<WidgetConfig>(['app', 'widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ app: { widget: { size: 3 } } })])

    expect(validated).toEqual({ app: { widget: { size: 3 } } })
    expect(slice.config.size).toBe(3)
  })

  // Under the passthrough schema there is nothing to drop, so an application that declared no schema of its own
  // still reads everything its sources carried.
  it('passes the whole tree through when the application declared no schema', async () => {
    const definition = new ConfigDefinition()
    definition.slice<WidgetConfig>(['widget'], widgetSchema)

    const { validated } = await resolve(definition, [new InlineConfigProvider({ widget: { size: 7 } })])

    expect(validated).toEqual({ widget: { size: 7 } })
  })

  it('carries nothing at all from a slice with no location', async () => {
    const definition = new ConfigDefinition()
    const slice = definition.slice<WidgetConfig>(undefined, widgetSchema, { size: 42 })

    const { validated } = await resolve(definition)

    expect(validated).toEqual({})
    expect(slice.config.size).toBe(42)
  })
})
