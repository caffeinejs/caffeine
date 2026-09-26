import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { ErrUnresolvableDependencies } from '../errors.js'
import { token } from '../key.js'

// These fixtures live apart because they cannot resolve: a container reading decorators would find them. In a file of
// their own nothing does, and they need no profile to stay out of the way — which would now hold them back until
// compile(), out of the reach of assertResolvable().
const kArfrPropDep = token<string>(Symbol('arfr-prop-dep'))
const kArfrMethodDep = token<Record<string, unknown>>(Symbol('arfr-method-dep'))

@Injectable()
class ArfrSvcWithPropInjection {
  @Inject(kArfrPropDep)
  accessor dep!: string
}

@Injectable()
class ArfrSvcWithMethodInjection {
  @Inject([kArfrMethodDep])
  init(_dep: unknown) {}
}

describe('assertResolvable() on member injections', function () {
  it('should throw when a property injection dependency is missing', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ArfrSvcWithPropInjection, t => t.toSelf())

    let caught: ErrUnresolvableDependencies | undefined
    try {
      di.assertResolvable()
    } catch (e) {
      caught = e as ErrUnresolvableDependencies
    }

    expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
    expect(caught!.issues).toHaveLength(1)
    expect(caught!.issues[0]).toContain(kArfrPropDep.toString())
  })

  it('should throw when a method injection dependency is missing', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ArfrSvcWithMethodInjection, t => t.toSelf())

    let caught: ErrUnresolvableDependencies | undefined
    try {
      di.assertResolvable()
    } catch (e) {
      caught = e as ErrUnresolvableDependencies
    }

    expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
    expect(caught!.issues).toHaveLength(1)
    expect(caught!.issues[0]).toContain(kArfrMethodDep.toString())
  })
})
