import { token } from '@caffeinejs/di'
import { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/std'
import { describe, it, expect, vi } from 'vitest'

import { AuthenticationBuilder } from './builder.js'
import { BaseAuthenticationHandler, type AuthenticationHandler } from './handler.js'
import { AuthenticateResult } from './ticket.js'

function makeKit(): FeatureConfigureKit {
  const internal = vi.fn()
  const toValue = vi.fn().mockReturnValue({ internal })
  const bind = vi.fn().mockReturnValue({ toValue })
  const wrap = vi.fn().mockReturnValue({ get: vi.fn() })
  return {
    container: { bind, wrap },
    config: {},
    store: {},
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

  // A default is used for every request that names no scheme of its own, so a name that resolves to nothing
  // fails all of them. It used to be checked only when an OAuth strategy was registered, and the challenge and
  // forbid defaults never.
  it.each([
    ['default', (b: AuthenticationBuilder) => b.default('Basci')],
    ['challenge', (b: AuthenticationBuilder) => b.defaultChallenge('Basci')],
    ['forbid', (b: AuthenticationBuilder) => b.defaultForbid('Basci')],
  ])('throws when the %s scheme names no registered scheme', (_label, misspell) => {
    const builder = new AuthenticationBuilder().addBasic(o => o.validate(vi.fn()))
    misspell(builder)

    expect(() => builder[kFeatureConfigure](makeKit())).toThrow(
      expect.objectContaining({ code: 'ERR_AUTH_SCHEME_NOT_FOUND', message: expect.stringContaining('"Basci"') }),
    )
  })

  // The second registration used to replace the first without a word.
  it.each([
    ['two built-in schemes', (b: AuthenticationBuilder) => b.addBasic('api', o => o.validate(vi.fn()))],
    ['a built-in scheme and a strategy', (b: AuthenticationBuilder) => b.addStrategy('api', handler())],
    ['a built-in scheme and a forward', (b: AuthenticationBuilder) => b.forward('api', () => 'api')],
  ])('throws when a name is registered twice: %s', (_label, again) => {
    const builder = new AuthenticationBuilder().addJWTBearer('api', o =>
      o.secret('secret').allowAnyIssuer().allowAnyAudience(),
    )

    expect(() => again(builder)).toThrow(/a scheme is already registered under the name "api"/)
  })

  // A named token used to be stored as if it were the handler, and every request failed on
  // "handler.authenticate is not a function".
  it.each([
    ['a symbol token', token<AuthenticationHandler>(Symbol('handler'))],
    ['a string token', token<AuthenticationHandler>('handler')],
    ['a class', StubHandler],
  ])('resolves a strategy registered by %s from the container', (_label, key) => {
    const kit = makeKit()
    const builder = new AuthenticationBuilder().addStrategy('api', key as never)

    expect(builder[kFeatureConfigure](kit)).toBeUndefined()
    expect(kit.container.wrap).toHaveBeenCalledWith(key)
  })

  it('uses a strategy registered as an instance as it is', () => {
    const kit = makeKit()
    const builder = new AuthenticationBuilder().addStrategy('api', handler())

    expect(builder[kFeatureConfigure](kit)).toBeUndefined()
    expect(kit.container.wrap).not.toHaveBeenCalled()
  })
})

class StubHandler extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  authenticate(): Promise<AuthenticateResult> {
    return Promise.resolve(AuthenticateResult.none())
  }
}

function handler(): AuthenticationHandler {
  return new StubHandler()
}
