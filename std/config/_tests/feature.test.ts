import { token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ConfigDefinition } from '../definition.js'
import { DEFAULT_INSTANCE, defineFeatureConfig, instanceNamespace } from '../feature.js'
import { EnvConfigProvider } from '../providers/env_provider.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { ConfigPriority } from '../sources.js'
import type { ConfigProvider, ResolutionContext } from '../types.js'

interface WidgetConfig {
  size: number
  label: string
}

const widgetSchema = $t.Object({
  size: $t.Number({ default: 1 }),
  label: $t.String({ default: 'widget' }),
})

const DEFAULTS: WidgetConfig = { size: 1, label: 'widget' }

/**
 * Resolves a definition the way the config module does at `container.init()`, so a test sees exactly what a
 * feature's slice would see after every band has been merged.
 */
async function resolve(definition: ConfigDefinition, extra: readonly ConfigProvider[] = []): Promise<void> {
  definition.sources.addAll(extra, ConfigPriority.ENV)

  const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

  await bootstrapConfig({
    sources: definition.sources,
    schema: definition.schema,
    slices: definition.slices,
    context: ctx,
  })
}

describe('instanceNamespace', () => {
  it('addresses the unnamed instance as "default"', () => {
    expect(instanceNamespace(['kafka'])).toEqual(['kafka', DEFAULT_INSTANCE])
  })

  it('addresses a named instance by its name', () => {
    expect(instanceNamespace(['kafka'], 'orders')).toEqual(['kafka', 'orders'])
  })

  it('does not mutate the base it was given', () => {
    const base = ['kafka']
    instanceNamespace(base, 'orders')
    expect(base).toEqual(['kafka'])
  })
})

describe('defineFeatureConfig', () => {
  it('resolves the framework defaults when nothing else says otherwise', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
    expect(slice.config.label).toBe('widget')
  })

  it('lets a code-set value override the framework default', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(7)
    expect(slice.config.label).toBe('widget')
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a code-set value', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7, label: 'from-code' },
    })

    await resolve(definition, [new EnvConfigProvider({ prefix: 'APP_', env: { APP_WIDGET__SIZE: '99' } })])

    expect(slice.config.size).toBe(99)
    // Untouched by the environment, so the code value still stands.
    expect(slice.config.label).toBe('from-code')
  })

  // A builder method nobody called must leave the framework default alone rather than writing a null over it.
  it('skips undefined values instead of writing them', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: undefined, label: undefined },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
    expect(slice.config.label).toBe('widget')
  })

  // Writing `values` as one object would have each key clear the path the previous key wrote.
  it('keeps every code-set key, not only the last', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      values: { size: 7, label: 'both' },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(7)
    expect(slice.config.label).toBe('both')
  })

  it('re-points reads and code-set defaults together when a selector is given', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      selector: (c: never) => (c as { app: { widget: unknown } }).app.widget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    await resolve(definition, [new InlineConfigProvider({ app: { widget: { label: 'moved' } } })])

    expect(slice.parts).toEqual(['app', 'widget'])
    // The code-set default followed the selector rather than staying at `widget.*`.
    expect(slice.config.size).toBe(7)
    expect(slice.config.label).toBe('moved')
  })

  it('keeps two instances of one feature apart', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))
    const fallback = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: instanceNamespace(['widget']),
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'unnamed' },
    })
    const orders = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: instanceNamespace(['widget'], 'orders'),
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'named' },
    })

    await resolve(definition, [new InlineConfigProvider({ widget: { orders: { size: 42 } } })])

    expect(fallback.parts).toEqual(['widget', 'default'])
    expect(fallback.config.label).toBe('unnamed')
    expect(fallback.config.size).toBe(1)
    expect(orders.config.label).toBe('named')
    expect(orders.config.size).toBe(42)
  })

  // Activation is the builder call, never the tree: no defineFeatureConfig, no slice, nothing read.
  it('reads nothing for a namespace no feature registered', async () => {
    const definition = new ConfigDefinition(token<any>(Symbol('app')))

    await resolve(definition, [new InlineConfigProvider({ widget: { size: 99 } })])

    expect(definition.slices).toHaveLength(0)
  })
})
