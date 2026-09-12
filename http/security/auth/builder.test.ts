import { token } from '@caffeinejs/di'
import { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/std'
import { ConfigDefinition } from '@caffeinejs/std/config'
import { describe, it, expect, vi } from 'vitest'

import { AuthenticationBuilder } from './builder.js'

function makeKit(): FeatureConfigureKit {
  const internal = vi.fn()
  const toValue = vi.fn().mockReturnValue({ internal })
  const bind = vi.fn().mockReturnValue({ toValue })
  const wrap = vi.fn().mockReturnValue({ get: vi.fn() })
  return {
    container: { bind, wrap },
    config: new ConfigDefinition(token<Record<string, unknown>>(Symbol('app.config'))),
  } as unknown as FeatureConfigureKit
}

describe('AuthenticationBuilder[kFeatureConfigure]()', () => {
  it('throws when no strategies are registered and no default scheme is set', () => {
    const builder = new AuthenticationBuilder()
    expect(() => builder[kFeatureConfigure](null as unknown as FeatureConfigureKit)).toThrow(
      'Cannot configure authentication: no strategies are registered',
    )
  })

  it('throws when multiple strategies are registered and no default scheme is set', () => {
    const validate = vi.fn()
    const builder = new AuthenticationBuilder()
    builder
      .addBasic(o => o.validate(validate))
      .addJWTBearer(o => o.secret('secret').allowAnyIssuer().allowAnyAudience())

    expect(() => builder[kFeatureConfigure](null as unknown as FeatureConfigureKit)).toThrow(
      'Cannot configure authentication: multiple strategies are registered and no default scheme is set',
    )
  })

  it('does not throw when exactly one strategy is registered and no default is set', () => {
    const builder = new AuthenticationBuilder()
    builder.addBasic(o => o.validate(vi.fn()))

    expect(builder[kFeatureConfigure](makeKit())).toBeUndefined()
  })

  it('does not throw when an explicit default is set with one strategy', () => {
    const builder = new AuthenticationBuilder()
    builder.addBasic(o => o.validate(vi.fn())).default('Basic')

    expect(builder[kFeatureConfigure](makeKit())).toBeUndefined()
  })

  it('does not throw when an explicit default is set with multiple strategies', () => {
    const builder = new AuthenticationBuilder()
    builder
      .addBasic(o => o.validate(vi.fn()))
      .addJWTBearer(o => o.secret('secret').allowAnyIssuer().allowAnyAudience())
      .default('Basic')

    expect(builder[kFeatureConfigure](makeKit())).toBeUndefined()
  })
})
