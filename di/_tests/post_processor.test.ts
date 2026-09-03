import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'

import { Binding } from '../binding.js'
import { CaffeineIoC } from '../container.js'
import { ByPassPostProcessors } from '../decorators/bypass_post_processors.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Provides } from '../decorators/provides.js'
import { Factory } from '../factory.js'
import { token } from '../key.js'
import { PostProcessor } from '../post_processor.js'
import { ResolutionContext } from '../resolution_context.js'
import { bindScope, Scope, unbindScope } from '../scope.js'

describe('Post Processors', function () {
  const ppSpy = vi.fn()
  const sSpy = vi.fn()
  const kScope = token<Scope>(Symbol('custom_transient'))

  class CustomTransient implements Scope {
    provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
      sSpy()
      return factory(ctx)
    }

    cachedInstance<T>(_binding: Binding): T | undefined {
      return undefined
    }

    reset(_binding: Binding): void {
      //
    }

    configure(_binding: Binding): void {
      //
    }

    undo(_binding: Binding): void {
      //
    }

    get lazy(): boolean {
      return false
    }

    get durable(): boolean {
      return false
    }
  }

  @Injectable()
  @Lifetime(kScope)
  class Dep {
    message() {
      return 'hello world'
    }
  }

  @Injectable()
  @ByPassPostProcessors()
  class ByPass {}

  class Comp {}

  @Configuration()
  class Conf {
    @Provides(Comp)
    @ByPassPostProcessors()
    comp() {
      return new Comp()
    }
  }

  @Injectable()
  class NonDep {}

  class Decorated extends Dep {
    constructor(readonly dep: Dep) {
      super()
    }

    message(): string {
      return `the message is ${this.dep.message()}`
    }
  }

  class PpOne implements PostProcessor {
    afterInit(ctx: ResolutionContext, instance: unknown): unknown {
      ppSpy()

      if (instance instanceof Dep) {
        return new Decorated(instance)
      }

      return instance
    }

    beforeInit(ctx: ResolutionContext, instance: unknown): unknown {
      ppSpy()
      return instance
    }
  }

  class PpTwo implements PostProcessor {
    afterInit(ctx: ResolutionContext, instance: unknown): unknown {
      ppSpy()
      return instance
    }

    beforeInit(ctx: ResolutionContext, instance: unknown): unknown {
      ppSpy()
      return instance
    }
  }

  let di: CaffeineIoC

  beforeAll(() => {
    bindScope(kScope, () => new CustomTransient())

    di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(new PpOne())
    di.postProcessors.add(new PpTwo())
  })

  afterAll(() => {
    unbindScope(kScope)

    di.postProcessors.clear()
  })

  it('should execute post processors calling the factory just one time per execution', async function () {
    di.autoWire()
    await di.init()

    const dep = di.get(Dep)
    const nonDep = di.get(NonDep)
    const conf = di.get(Conf)

    // Ensure it does not impact on the count since they should bypass post processors
    di.get(ByPass)
    di.get(Comp)

    await di.dispose()

    expect(ppSpy).toHaveBeenCalledTimes(16)
    expect(sSpy).toHaveBeenCalledTimes(2)
    expect(nonDep).toBeInstanceOf(NonDep)
    expect(dep).toBeInstanceOf(Decorated)
    expect(conf).toBeInstanceOf(Conf)
    expect(dep.message()).toEqual('the message is hello world')
  })
})
