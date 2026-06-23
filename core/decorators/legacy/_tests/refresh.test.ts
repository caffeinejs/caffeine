import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Injectable } from '../injectable.legacy.js'
import { Lifetime } from '../lifetime.legacy.js'
import { Scopes } from '../../../scope.js'

describe('Legacy @Refresh', function () {
  @Lifetime(Scopes.REFRESH)
  @Injectable()
  class RefreshToken {
    readonly id = Math.random()
  }

  let di: DiCaf

  beforeAll(async () => {
    di = new DiCaf()
    await di.init()
  })

  it('binding has refresh scope', function () {
    expect(di.getBinding(RefreshToken).scopeId).toBe(Scopes.REFRESH)
  })

  it('produces same instance before refresh', function () {
    const a = di.get(RefreshToken)
    const b = di.get(RefreshToken)
    expect(a).toBe(b)
  })

  it('produces new instance after refresh', async function () {
    const before = di.get(RefreshToken)
    await di.refresher.refresh()
    const after = di.get(RefreshToken)
    expect(after).toBeInstanceOf(RefreshToken)
    expect(before).not.toBe(after)
  })
})
