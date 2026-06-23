import { describe, it, beforeEach, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Injectable } from '../decorators/injectable.js'
import { Lazy } from '../decorators/lazy.js'
import { UseFactory } from '../decorators/use_factory.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Scopes } from '../scope.js'
import { DiCaf } from '../container.js'
import { classFactory } from '../internal/core/factory/class.js'
import { Factory } from '../factory.js'
import { ResolutionContext } from '../resolution_context.js'

describe(`@${UseFactory.name}()`, function () {
  const spy = vi.fn()

  beforeEach(() => {
    spy.mockReset()
  })

  function logSetterProvider<T>(inner: () => Factory<T>): Factory<T> {
    return (ctx: ResolutionContext): T => {
      const instance = inner()(ctx)
      spy()
      return instance
    }
  }

  @Injectable()
  @Lazy()
  @UseFactory(logSetterProvider(() => classFactory(Loggable)))
  class Loggable {
    static Log() {
      return 'the_log'
    }
  }

  @Injectable()
  @Lazy()
  @UseFactory(() => {
    spy()
    return new Dep('created')
  })
  class Dep {
    constructor(readonly status: string) {}
  }

  it('should use custom factory provided in the decorator', async function () {
    const di = new DiCaf()
    await di.init()
    const loggable = di.get(Loggable)

    expect(Loggable.Log())
      .toEqual('the_log')
    expect(loggable)
      .toBeInstanceOf(Loggable)
    expect(spy)
      .toHaveBeenCalledTimes(1)
  })

  it('should use a factory factory using the function provided in the decorator', async function () {
    const di = new DiCaf()
    await di.init()
    const dep = di.get(Dep)

    expect(spy)
      .toHaveBeenCalledTimes(1)
    expect(dep)
      .toBeInstanceOf(Dep)
  })

  class Repo<T = any> {
    readonly id: string = randomUUID()

    constructor(readonly model: T) {}

    name() {
      return (this.model as any).name
    }
  }

  function repoProvider<T>(): (ctx: ResolutionContext) => Repo<T> {
    return (ctx: ResolutionContext): Repo<T> => new Repo<T>(ctx.key as any)
  }

  @Injectable()
  @UseFactory(repoProvider())
  class User {}

  @Injectable()
  @UseFactory(repoProvider())
  @Lifetime(Scopes.TRANSIENT)
  class TrUser {}

  @Injectable([User])
  class Svc {
    constructor(readonly repo: Repo<User>) {}
  }

  it('should provide another bean instance different from the decorated type', async function () {
    const di = new DiCaf()
    await di.init()
    const repo = di.get(User) as Repo<User>
    const repo2 = di.get(User) as Repo

    expect(repo)
      .toBeInstanceOf(Repo)
    expect(repo.name())
      .toEqual('User')
    expect(repo.id)
      .toEqual(repo2.id)
  })

  it('should provide another bean respecting configurations set on key class', async function () {
    const di = new DiCaf()
    await di.init()
    const repo = di.get(TrUser) as Repo<User>
    const repo2 = di.get(TrUser) as Repo

    expect(repo)
      .toBeInstanceOf(Repo)
    expect(repo.name())
      .toEqual('TrUser')
    expect(repo.id).not.toEqual(repo2.id)
  })

  it('should inject provided component', async function () {
    const di = new DiCaf()
    await di.init()
    const svc = di.get(Svc)

    expect(svc)
      .toBeInstanceOf(Svc)
    expect(svc.repo)
      .toBeInstanceOf(Repo)
    expect(svc.repo.name())
      .toEqual('User')
  })
})
