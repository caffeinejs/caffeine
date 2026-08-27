import { describe, expect, it } from 'bun:test'
import { bucketFiles, dirDepth, exceedsMaxDepth, isGeneratedMod, isHandwrittenMod, isSkipped, moduleDir, toRootRel } from './_module_graph_partition.js'

describe('module graph partition', () => {
  it('maps src-relative paths onto the walk root', () => {
    expect(toRootRel('src/orders/foo.ts', 'src')).toBe('orders/foo.ts')
    expect(toRootRel('src/app.ts', 'src')).toBe('app.ts')
    expect(toRootRel('other/foo.ts', 'src')).toBeUndefined()
  })

  it('assigns depth-0 files to the app bucket', () => {
    expect(moduleDir('', { depth: 1, depths: {} })).toBe('')
  })

  it('stops at default depth 1', () => {
    expect(moduleDir('orders', { depth: 1, depths: {} })).toBe('orders')
    expect(moduleDir('orders/internal', { depth: 1, depths: {} })).toBe('orders')
  })

  it('overrides stop depth for libs', () => {
    const opts = { depth: 1, depths: { libs: 2 } }
    expect(moduleDir('libs', opts)).toBe('')
    expect(moduleDir('libs/db', opts)).toBe('libs/db')
    expect(moduleDir('libs/cache', opts)).toBe('libs/cache')
    expect(moduleDir('libs/db/internal', opts)).toBe('libs/db')
  })

  it('drops skip prefixes and maxDepth', () => {
    expect(isSkipped('vendor/x.ts', ['vendor'])).toBe(true)
    expect(isSkipped('orders/x.ts', ['vendor'])).toBe(false)
    expect(dirDepth('a/b/c')).toBe(3)
    expect(exceedsMaxDepth('a/b/c/d/e/f/g/h/i/file.ts', 8)).toBe(true)
    expect(exceedsMaxDepth('a/b/c/file.ts', 8)).toBe(false)
  })

  it('buckets files and ignores generated modules', () => {
    const buckets = bucketFiles([
      'app.ts',
      'orders/order.ts',
      'orders/internal/x.ts',
      'libs/util.ts',
      'libs/db/client.ts',
      'vendor/skip.ts',
      'orders/orders.generated.mod.ts',
    ], {
      depth: 1,
      depths: { libs: 2 },
      maxDepth: 8,
      skip: ['vendor'],
    })

    expect([...buckets.keys()].sort()).toEqual(['', 'libs/db', 'orders'])
    expect(buckets.get('')).toEqual(['app.ts', 'libs/util.ts'])
    expect(buckets.get('orders')).toEqual(['orders/order.ts', 'orders/internal/x.ts'])
    expect(buckets.get('libs/db')).toEqual(['libs/db/client.ts'])
  })

  it('distinguishes handwritten and generated mod files', () => {
    expect(isGeneratedMod('orders/orders.generated.mod.ts')).toBe(true)
    expect(isHandwrittenMod('orders/orders.mod.ts')).toBe(true)
    expect(isHandwrittenMod('orders/orders.generated.mod.ts')).toBe(false)
  })
})
