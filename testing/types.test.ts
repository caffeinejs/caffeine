import { describe, expectTypeOf, it } from 'vitest'
import type { ControllerTestClient } from './controller_client.js'
import type { RouteMethods } from './types.js'

class _Fixture {
  list(): unknown[] {
    return []
  }

  create(_data: { name: string }): { id: number } {
    return { id: 1 }
  }

  remove(_id: string): { ok: boolean } {
    return { ok: true }
  }
}

describe('testing core types', () => {
  describe('when using RouteMethodKeys', () => {
    it('it extracts handler names', () => {
      expectTypeOf<RouteMethods<typeof _Fixture>>().toEqualTypeOf<'list' | 'create' | 'remove'>()
    })
  })

  describe('when using ControllerTestClient', () => {
    it('it narrows keys to handler names', () => {
      expectTypeOf<keyof ControllerTestClient<typeof _Fixture>>().toEqualTypeOf<'list' | 'create' | 'remove'>()
    })
  })
})
