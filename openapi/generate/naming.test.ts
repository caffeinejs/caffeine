import type { IRouteGroup } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { routerBaseName } from './naming.js'

const group = (name: string) => ({ name }) as IRouteGroup<unknown>

describe('routerBaseName', () => {
  it('drops a trailing Controller', () => {
    expect(routerBaseName(group('PetsController'))).toBe('Pets')
  })

  // An empty tag and an operationId starting with "_" would both be unusable to a client generator.
  it('keeps a group named only Controller as it is', () => {
    expect(routerBaseName(group('Controller'))).toBe('Controller')
  })
})
