import { describe, it, expect, vi } from 'vitest'
import type { Container } from '@caffeinejs/di'
import { kServiceConfigure } from '@caffeinejs/std'
import type { ServiceKit } from '../../service.js'
import type { Feats } from '../../feats.js'
import { AuthenticationBuilder } from './builder.js'

function makeKit(): ServiceKit {
  const internal = vi.fn()
  const toValue = vi.fn().mockReturnValue({ internal })
  const bind = vi.fn().mockReturnValue({ toValue })
  const wrap = vi.fn().mockReturnValue({ get: vi.fn() })
  return {
    container: { bind, wrap } as unknown as Container,
    feats: { toggleAuthentication: vi.fn().mockReturnThis() } as unknown as Feats,
  }
}

describe('AuthenticationBuilder[kConfigure]()', () => {
  it('throws when no strategies are registered and no default scheme is set', () => {
    const builder = new AuthenticationBuilder()
    expect(() => builder[kServiceConfigure](null as unknown as ServiceKit)).toThrow(
      'Cannot configure authentication: no strategies are registered',
    )
  })

  it('throws when multiple strategies are registered and no default scheme is set', () => {
    const validate = vi.fn()
    const builder = new AuthenticationBuilder()
      .addBasic(o => o.validate(validate))
      .addJWTBearer(o => o.secret('secret'))

    expect(() => builder[kServiceConfigure](null as unknown as ServiceKit)).toThrow(
      'Cannot configure authentication: multiple strategies are registered and no default scheme is set',
    )
  })

  it('does not throw when exactly one strategy is registered and no default is set', async () => {
    const builder = new AuthenticationBuilder()
      .addBasic(o => o.validate(vi.fn()))

    await expect(builder[kServiceConfigure](makeKit())).resolves.toBeUndefined()
  })

  it('does not throw when an explicit default is set with one strategy', async () => {
    const builder = new AuthenticationBuilder()
      .addBasic(o => o.validate(vi.fn()))
      .default('Basic')

    await expect(builder[kServiceConfigure](makeKit())).resolves.toBeUndefined()
  })

  it('does not throw when an explicit default is set with multiple strategies', async () => {
    const builder = new AuthenticationBuilder()
      .addBasic(o => o.validate(vi.fn()))
      .addJWTBearer(o => o.secret('secret'))
      .default('Basic')

    await expect(builder[kServiceConfigure](makeKit())).resolves.toBeUndefined()
  })
})
