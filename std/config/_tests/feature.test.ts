import { token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import type { ConfigHandle } from '../accessor.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ConfigDefinition } from '../definition.js'
import { DEFAULT_INSTANCE, defineFeatureConfig, instanceNamespace } from '../feature.js'
import { featureConfigKey } from '../feature_key.js'
import { EnvConfigProvider } from '../providers/env_provider.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import type { ConfigSchema } from '../schema.js'
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

/** {@link resolve}, handing back the config handle — what a reader holding no builder actually has. */
async function resolveHandle(
  definition: ConfigDefinition,
  extra: readonly ConfigProvider[] = [],
): Promise<ConfigHandle<unknown>> {
  definition.sources.addAll(extra, ConfigPriority.ENV)

  const result = await bootstrapConfig({
    sources: definition.sources,
    schema: definition.schema,
    slices: definition.slices,
    features: definition.features,
    context: { app: 'test', profiles: ['default'] },
  })

  return result.config
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
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
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))

    await resolve(definition, [new InlineConfigProvider({ widget: { size: 99 } })])

    expect(definition.slices).toHaveLength(0)
  })
})

/**
 * A key exists so that code holding no builder can read a feature's configuration — a `Responder`, a
 * middleware, anything handed only a request context. The tests below are about that reader's guarantees, not
 * about the tree, so each one asks the *handle* rather than the slice.
 */
describe('feature config keys', () => {
  const kWidget = featureConfigKey<WidgetConfig>('widget')

  it('answers the key with the feature configuration', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    const config = await resolveHandle(definition)

    expect(config(kWidget)).toEqual({ size: 7, label: 'widget' })
  })

  // The whole reason a key beats a namespace: a reader cannot hard-code a path the feature is free to move.
  it('finds a slice the application relocated', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      selector: (c: never) => (c as { app: { widget: unknown } }).app.widget,
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    const config = await resolveHandle(definition, [new InlineConfigProvider({ app: { widget: { size: 42 } } })])

    expect(config(kWidget)).toEqual({ size: 42, label: 'widget' })
    // Nothing lives at the default path any more, so a reader that had gone looking there would find nothing.
    expect((config as { widget?: unknown }).widget).toBeUndefined()
  })

  // A feature the application never installed is absent, not broken — which is what lets a package ship a
  // fallback (`HTML(...)` renders with its own defaults) instead of requiring the feature to be installed.
  it('answers undefined for a key nothing registered', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))

    const config = await resolveHandle(definition)

    expect(config(kWidget)).toBeUndefined()
  })

  it('leaves a slice registered without a key unreachable by any key', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    const config = await resolveHandle(definition)

    expect(definition.slices).toHaveLength(1)
    expect(config(kWidget)).toBeUndefined()
  })

  // Two slices under one key would make the answer depend on install order. Refusing is also what tells a
  // multi-instance feature that one key cannot address all of its instances.
  it('refuses a second slice under the same key', () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const register = (namespace: readonly string[]): void => {
      defineFeatureConfig<WidgetConfig>(definition, { namespace, key: kWidget, schema: widgetSchema })
    }

    register(instanceNamespace(['widget']))

    expect(() => {
      register(instanceNamespace(['widget'], 'orders'))
    }).toThrow(expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_FEATURE_CONFLICT' }))
  })

  // The handle stays an ordinary config tree: being callable must not make it look like a function to anything
  // that walks or serializes it.
  it('reads as a plain tree despite being callable', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    const config = await resolveHandle(definition, [new InlineConfigProvider({ widget: { size: 3 } })])

    expect(Object.keys(config)).toEqual(['widget'])
    // oxlint-disable-next-line typescript/no-misused-spread -- the handle is callable; spreading must still work
    expect({ ...config }).toEqual({ widget: { size: 3, label: 'widget' } })
    expect(JSON.parse(JSON.stringify(config))).toEqual({ widget: { size: 3, label: 'widget' } })
  })
})

/**
 * An application must be able to default a feature it did not write.
 *
 * A schema `default` cannot do that on its own: a feature writes its framework defaults as real tree values,
 * and a schema default only fills a value that is *absent*. Lifting the schema's declared defaults into their
 * own band is what puts the two in the same merge — the bug `examples/03-petstore` shipped with, where a
 * declared `server.port` of 9999 never applied and the process listened on an OS-assigned port.
 */
describe('application schema defaults', () => {
  const appSchema = $t.Object({
    widget: $t.Object(
      { size: $t.Number({ default: 9999 }), label: $t.String({ default: 'from-schema' }) },
      { default: {} },
    ),
  })

  function definitionWith(schema: ConfigSchema<unknown>): ConfigDefinition {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    definition.schema = schema
    return definition
  }

  it('beats the framework default the feature registered', async () => {
    const definition = definitionWith(appSchema)
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(9999)
    expect(slice.config.label).toBe('from-schema')
  })

  // Declaring a shape is a weaker statement than calling a method, so the builder still wins.
  it('loses to a value the feature builder set', async () => {
    const definition = definitionWith(appSchema)
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(7)
    // Untouched by the builder, so the schema default still stands.
    expect(slice.config.label).toBe('from-schema')
  })

  it('loses to the environment, so a deployment still overrides it', async () => {
    const definition = definitionWith(appSchema)
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition, [new EnvConfigProvider({ prefix: 'APP_', env: { APP_WIDGET__SIZE: '11' } })])

    expect(slice.config.size).toBe(11)
  })

  // `Value.Default` is TypeBox's. A foreign Standard Schema exposes nothing to walk, the same limitation
  // `secretPaths` has, so its defaults reach the root tree and go no further.
  it('contributes nothing from a foreign Standard Schema', async () => {
    const definition = definitionWith(z.object({ widget: z.object({ size: z.number().default(9999) }) }))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
  })

  it('leaves a feature alone when the schema declares no default for it', async () => {
    const definition = definitionWith($t.Object({ widget: $t.Object({ size: $t.Optional($t.Number()) }) }))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      namespace: ['widget'],
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
  })
})
