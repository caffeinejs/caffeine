import type { InferSchema } from '@caffeinejs/application/schema'
import type { RouteRecord } from '@caffeinejs/http'
import { describe, expectTypeOf, it } from 'vitest'

import type { RouteSchema } from './routes.schema.js'

type Served = InferSchema<typeof RouteSchema>

/**
 * A response schema is also what the response is serialized with, and a field it does not declare is dropped from
 * the answer without a word. These keep the schema's fields the inventory's, one level at a time.
 */
describe('RouteSchema', () => {
  it('declares every field of a route record', () => {
    expectTypeOf<keyof Served>().toEqualTypeOf<keyof RouteRecord>()
    expectTypeOf<keyof Served['schema']>().toEqualTypeOf<keyof RouteRecord['schema']>()
  })

  it('declares every field of what protects a route', () => {
    type Security = RouteRecord['security']

    expectTypeOf<keyof Served['security']>().toEqualTypeOf<keyof Security>()
    expectTypeOf<keyof Served['security']['authentication']>().toEqualTypeOf<keyof Security['authentication']>()
    expectTypeOf<keyof Served['security']['authorization']>().toEqualTypeOf<keyof Security['authorization']>()
  })
})
