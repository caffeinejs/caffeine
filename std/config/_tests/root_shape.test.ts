import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { InlineConfigSource } from '../sources/inline_source.js'
import { kMergedTree } from '../store.js'
import type { ConfigSchema } from '../types.js'

function definition<T>(data: Record<string, unknown>, schema: ConfigSchema<T>) {
  return { schema, key: undefined, storeKey: undefined, sources: [new InlineConfigSource(data)], loadTimeoutMs: 30_000 }
}

/**
 * The configuration an application reads is its schema and nothing else. A feature never adds a field to it, so the
 * shape of `ctx.config` and of an injected config object is a property of the schema, not of the features installed.
 */
describe('the configuration an application reads', () => {
  it('drops what the schema does not declare', async () => {
    const schema = $t.Object({ catalog: $t.Object({ pageSize: $t.Number({ default: 25 }) }, { default: {} }) })

    const store = await loadConfig(definition({ widget: { size: 7 }, catalog: {} }, schema))

    expect(store.current).toEqual({ catalog: { pageSize: 25 } })
  })

  // Dropped from the snapshot, still in the merged tree, which is where the application reads its own block.
  it('keeps an undeclared block in the merged tree', async () => {
    const schema = $t.Object({ catalog: $t.Object({ pageSize: $t.Number({ default: 25 }) }, { default: {} }) })

    const store = await loadConfig(definition({ caffeine: { name: 'app' } }, schema))

    expect(store[kMergedTree]).toEqual({ caffeine: { name: 'app' } })
  })

  it('keeps a block the schema declared', async () => {
    const schema = $t.Object({ app: $t.Object({ widget: $t.Object({ size: $t.Number() }) }, { default: {} }) })

    const store = await loadConfig(definition({ app: { widget: { size: 3 } } }, schema))

    expect(store.current).toEqual({ app: { widget: { size: 3 } } })
  })

  it('passes the whole tree through when no schema was declared', async () => {
    const store = await loadConfig(definition({ widget: { size: 7 } }, passthroughConfigSchema))

    expect(store.current).toEqual({ widget: { size: 7 } })
  })
})
