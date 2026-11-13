import { expectTypeOf, test } from 'vitest'

import { contextKey, ExecutionContext } from './context.js'

test('a slot is written and read with the type its key declares', () => {
  const kTenant = contextKey<string>('tenant')

  // @ts-expect-error a string slot cannot be written through a widened key
  ExecutionContext.ROOT.with<string | number>(kTenant, 123)

  expectTypeOf(ExecutionContext.ROOT.with(kTenant, 'acme').get(kTenant)).toEqualTypeOf<string | undefined>()
})
