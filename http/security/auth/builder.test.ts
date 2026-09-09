import type { Container } from '@caffeinejs/di'
import { token } from '@caffeinejs/di'
import { ApplicationAvailability, kBootstrap, type BootstrapKit } from '@caffeinejs/std'
import { ConfigDefinition } from '@caffeinejs/std/config'
import { describe, it, expect, vi } from 'vitest'

import { AuthenticationBuilder } from './builder.js'

function makeKit(): BootstrapKit {
  const internal = vi.fn()
  const toValue = vi.fn().mockReturnValue({ internal })
  const bind = vi.fn().mockReturnValue({ toValue })
  const wrap = vi.fn().mockReturnValue({ get: vi.fn() })
  return {
    container: { bind, wrap } as unknown as Container,
    availability: new ApplicationAvailability(),
    config: new ConfigDefinition(token<Record<string, unknown>>(Symbol('app.config'))),
    extensions: { register: () => undefined },
  }
}

describe('AuthenticationBuilder[kConfigure]()', () => {
  it('throws when no strategies are registered and no default scheme is set', () => {
    const builder = new AuthenticationBuilder()
    expect(() => builder[kBootstrap](null as unknown as BootstrapKit)).toThrow(
      'Cannot configure authentication: no strategies are registered',
    )
  })

  it('throws when multiple strategies are registered and no default scheme is set', () => {
    const validate = vi.fn()
    const builder = new AuthenticationBuilder()
    builder
      .addBasic(o => o.validate(validate))
      .addJWTBearer(o => o.secret('secret').allowAnyIssuer().allowAnyAudience())

    expect(() => builder[kBootstrap](null as unknown as BootstrapKit)).toThrow(
      'Cannot configure authentication: multiple strategies are registered and no default scheme is set',
    )
  })

  it('does not throw when exactly one strategy is registered and no default is set', async () => {
    const builder = new AuthenticationBuilder()
    builder.addBasic(o => o.validate(vi.fn()))

    await expect(builder[kBootstrap](makeKit())).resolves.toBeUndefined()
  })

  it('does not throw when an explicit default is set with one strategy', async () => {
    const builder = new AuthenticationBuilder()
    builder.addBasic(o => o.validate(vi.fn())).default('Basic')

    await expect(builder[kBootstrap](makeKit())).resolves.toBeUndefined()
  })

  it('does not throw when an explicit default is set with multiple strategies', async () => {
    const builder = new AuthenticationBuilder()
    builder
      .addBasic(o => o.validate(vi.fn()))
      .addJWTBearer(o => o.secret('secret').allowAnyIssuer().allowAnyAudience())
      .default('Basic')

    await expect(builder[kBootstrap](makeKit())).resolves.toBeUndefined()
  })
})
