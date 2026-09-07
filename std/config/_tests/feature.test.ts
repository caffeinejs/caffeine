import { token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import type { ConfigHandle } from '../accessor.js'
import { bootstrapConfig } from '../bootstrap.js'
import { ConfigDefinition } from '../definition.js'
import { defineFeatureConfig } from '../feature.js'
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

/**
 * Records a location the way a feature builder's `.config(...)` does — `at('app', 'widget')` is
 * `c => c.app.widget`. A feature has no location of its own any more, so every placed slice needs one.
 */
function at(...parts: readonly string[]): (c: never) => unknown {
  return c => parts.reduce<Record<string, never>>((node, part) => node[part], c as Record<string, never>)
}

describe('defineFeatureConfig', () => {
  it('resolves the framework defaults when nothing else says otherwise', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
      schema: widgetSchema,
      values: { size: 7, label: 'both' },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(7)
    expect(slice.config.label).toBe('both')
  })

  it('places reads and code-set defaults together where the selector points', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('app', 'widget'),
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
      selector: at('widget', 'default'),
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'unnamed' },
    })
    const orders = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('widget', 'orders'),
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
  it('reads nothing for a location no feature registered', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))

    await resolve(definition, [new InlineConfigProvider({ widget: { size: 99 } })])

    expect(definition.slices).toHaveLength(0)
  })
})

/**
 * A feature the application never placed anywhere.
 *
 * It still works — that is the point: installing a feature must not force an application to describe it in its
 * own schema. What it gives up is everything outside the process: no file, environment variable or argument
 * reaches a slice that is not in the tree, because nothing in the tree was ever declared to be about it.
 */
describe('a slice with no location', () => {
  it('resolves from the feature defaults and the builder values', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    await resolve(definition)

    expect(slice.parts).toBeUndefined()
    expect(slice.config.size).toBe(7)
    expect(slice.config.label).toBe('widget')
  })

  // Guessing that `widget.*` is meant for this feature is exactly what the rework removed.
  it('ignores a tree value at the name the feature goes by', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition, [
      new InlineConfigProvider({ widget: { size: 99 } }),
      new EnvConfigProvider({ prefix: 'APP_', env: { APP_WIDGET__LABEL: 'from-env' } }),
    ])

    expect(slice.config.size).toBe(1)
    expect(slice.config.label).toBe('widget')
  })

  it('writes nothing into the tree the application declared', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, { schema: widgetSchema, defaults: { ...DEFAULTS } })

    const config = await resolveHandle(definition)

    expect(Object.keys(config)).toEqual([])
  })

  it('is still reachable by its feature key', async () => {
    const kWidget = featureConfigKey<WidgetConfig>('detached-widget')
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'from-code' },
    })

    const config = await resolveHandle(definition)

    expect(config(kWidget)).toEqual({ size: 1, label: 'from-code' })
  })

  it('keeps two instances of one feature apart', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const fallback = defineFeatureConfig<WidgetConfig>(definition, {
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'unnamed' },
    })
    const orders = defineFeatureConfig<WidgetConfig>(definition, {
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { label: 'named', size: 42 },
    })

    await resolve(definition)

    expect(fallback.config).toEqual({ size: 1, label: 'unnamed' })
    expect(orders.config).toEqual({ size: 42, label: 'named' })
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
      selector: at('widget'),
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
      values: { size: 7 },
    })

    const config = await resolveHandle(definition)

    expect(config(kWidget)).toEqual({ size: 7, label: 'widget' })
  })

  // The whole reason a key beats a path: a reader cannot hard-code a location the application chooses.
  it('finds a slice the application relocated', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('app', 'widget'),
      key: kWidget,
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    const config = await resolveHandle(definition, [new InlineConfigProvider({ app: { widget: { size: 42 } } })])

    expect(config(kWidget)).toEqual({ size: 42, label: 'widget' })
    // The feature contributed no field of its own, so a reader that had gone looking under `widget` finds nothing.
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
      selector: at('widget'),
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
    const register = (selector: (c: never) => unknown): void => {
      defineFeatureConfig<WidgetConfig>(definition, { selector, key: kWidget, schema: widgetSchema })
    }

    register(at('widget', 'default'))

    expect(() => {
      register(at('widget', 'orders'))
    }).toThrow(expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_FEATURE_CONFLICT' }))
  })

  // The handle stays an ordinary config tree: being callable must not make it look like a function to anything
  // that walks or serializes it.
  it('reads as a plain tree despite being callable', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
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
      selector: at('widget'),
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
  })

  it('leaves a feature alone when the schema declares no default for it', async () => {
    const definition = definitionWith($t.Object({ widget: $t.Object({ size: $t.Optional($t.Number()) }) }))
    const slice = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('widget'),
      schema: widgetSchema,
      defaults: { ...DEFAULTS },
    })

    await resolve(definition)

    expect(slice.config.size).toBe(1)
  })
})

interface GadgetConfig {
  paths: { live: string; ready: string }
  hosts: string[]
}

const gadgetSchema = $t.Object({
  paths: $t.Object({ live: $t.String(), ready: $t.String() }),
  hosts: $t.Array($t.String()),
})

const GADGET_DEFAULTS: GadgetConfig = { paths: { live: '/livez', ready: '/readyz' }, hosts: ['a', 'b', 'c'] }

/**
 * Where a feature was pointed decides where its *overrides* come from. It never decides what the feature's own
 * defaults and builder values add up to — both paths merge the same two bands the same way.
 */
describe('a feature resolving its own two bands', () => {
  it('merges a nested builder value into the defaults rather than replacing them', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<GadgetConfig>(definition, {
      schema: gadgetSchema,
      defaults: { ...GADGET_DEFAULTS },
      values: { paths: { live: '/l' } },
    })

    await resolve(definition)

    // A builder that set one field of a block must not delete the sibling defaults it never mentioned.
    expect(slice.config.paths).toEqual({ live: '/l', ready: '/readyz' })
  })

  it('replaces an array default wholesale rather than patching it', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const slice = defineFeatureConfig<GadgetConfig>(definition, {
      schema: gadgetSchema,
      defaults: { ...GADGET_DEFAULTS },
      values: { hosts: ['x', 'y'] },
    })

    await resolve(definition)

    // The array rule is the engine's, and it must not depend on whether the feature was placed.
    expect(slice.config.hosts).toEqual(['x', 'y'])
  })

  // The test that fails the moment anyone gives the detached path a merge of its own again.
  it('resolves to the same object placed and detached, given the same inputs', async () => {
    const spec = {
      schema: gadgetSchema as ConfigSchema<GadgetConfig>,
      defaults: { ...GADGET_DEFAULTS },
      values: { paths: { live: '/l' }, hosts: ['x', 'y'] },
    }

    const placedDefinition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const placed = defineFeatureConfig<GadgetConfig>(placedDefinition, { ...spec, selector: at('app', 'gadget') })
    await resolve(placedDefinition)

    const detachedDefinition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const detached = defineFeatureConfig<GadgetConfig>(detachedDefinition, spec)
    await resolve(detachedDefinition)

    expect(detached.snapshot()).toEqual(placed.snapshot())
  })

  /**
   * Two features may legitimately share one location — the application chose it, and nothing stops it naming
   * the same block twice. Their defaults have to merge for the same reason their builder values do.
   */
  it('keeps the defaults of two features pointed at one location', async () => {
    const definition = new ConfigDefinition(token<Record<string, unknown>>(Symbol('app')))
    const first = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('app', 'shared'),
      schema: widgetSchema,
      defaults: { size: 5 },
    })
    const second = defineFeatureConfig<WidgetConfig>(definition, {
      selector: at('app', 'shared'),
      schema: widgetSchema,
      defaults: { label: 'second' },
    })

    await resolve(definition)

    expect(first.config).toEqual({ size: 5, label: 'second' })
    expect(second.config).toEqual({ size: 5, label: 'second' })
  })
})
