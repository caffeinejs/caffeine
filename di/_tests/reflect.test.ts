import { describe, it, expect, vi } from 'vitest'

import { createAnnotation } from '../annotations.js'
import { reflect } from '../reflect.js'
import { Keys } from '../symbols.js'
import type { AnyClass } from '../types.js'

const kRoles = Symbol('roles')
const kTitle = Symbol('title')

function Roles(...roles: string[]) {
  return (_target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
    reflect.annotate(context, kRoles, roles)
  }
}

function Title(title: string) {
  return (_target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
    reflect.annotate(context, kTitle, title)
  }
}

function storeOf(cls: AnyClass): unknown {
  return cls[Symbol.metadata]?.[Keys.kMetadata]
}

describe('reflect.get', function () {
  @Roles('admin')
  @Title('users')
  class Users {
    @Roles('editor')
    edit() {}

    list() {}
  }

  it('returns the class slot', function () {
    expect(reflect.get<string[]>(Users, kRoles)).toEqual(['admin'])
    expect(reflect.get<string>(Users, kTitle)).toBe('users')
  })

  it('returns the member slot without falling back to the class', function () {
    expect(reflect.get<string[]>(Users, kRoles, 'edit')).toEqual(['editor'])
    expect(reflect.get<string[]>(Users, kRoles, 'list')).toBeUndefined()
  })

  it('returns undefined when the key is absent', function () {
    const kMissing = Symbol('missing')
    expect(reflect.get(Users, kMissing)).toBeUndefined()
    expect(reflect.get(Users, kMissing, 'edit')).toBeUndefined()
  })

  it('returns undefined for a class with no Symbol.metadata', function () {
    class Bare {
      run() {}
    }
    expect(reflect.get(Bare, kRoles)).toBeUndefined()
    expect(reflect.get(Bare, kRoles, 'run')).toBeUndefined()
  })

  it('two symbol keys on the same class do not collide', function () {
    expect(reflect.get<string[]>(Users, kRoles)).toEqual(['admin'])
    expect(reflect.get<string>(Users, kTitle)).toBe('users')
  })

  it('round-trips a symbol-named member', function () {
    const run = Symbol('run')
    class Jobs {
      @Roles('worker')
      [run]() {}
    }
    expect(reflect.get<string[]>(Jobs, kRoles, run)).toEqual(['worker'])
  })

  it('infers the value type from an annotation key and takes an explicit one for a symbol key', function () {
    const Label = createAnnotation.on('class')<string>()
    const Weight = createAnnotation.on('method')<number>()

    @Label('cls')
    class T {
      @Weight(1)
      go() {}
    }

    const c: string | undefined = reflect.get(T, Label)
    const m: number | undefined = reflect.get(T, Weight, 'go')
    const s: string[] | undefined = reflect.get<string[]>(Users, kRoles)
    const u: unknown = reflect.get(Users, kRoles)

    expect([c, m, s, u]).toEqual(['cls', 1, ['admin'], ['admin']])
  })
})

describe('reflect.effective', function () {
  @Roles('admin')
  class AdminCtrl {
    @Roles('superadmin')
    delete() {}

    list() {}
  }

  it('prefers the member slot', function () {
    expect(reflect.effective<string[]>(AdminCtrl, kRoles, 'delete')).toEqual(['superadmin'])
  })

  it('falls back to the class slot', function () {
    expect(reflect.effective<string[]>(AdminCtrl, kRoles, 'list')).toEqual(['admin'])
  })

  it('returns undefined when neither slot is set', function () {
    class Plain {
      run() {}
    }
    expect(reflect.effective(Plain, kRoles, 'run')).toBeUndefined()
  })
})

describe('reflect.annotate', function () {
  it('memberName writes that member slot regardless of the decorator kind', function () {
    function TitleOf(title: string, member: string) {
      return (_target: unknown, context: ClassDecoratorContext) => {
        reflect.annotate(context, kTitle, title, member)
      }
    }

    @TitleOf('synthetic title', 'synthetic')
    class T {}

    expect(reflect.get<string>(T, kTitle, 'synthetic')).toBe('synthetic title')
    expect(reflect.get(T, kTitle)).toBeUndefined()
  })

  it('a subclass never writes into its base class (issue #93)', function () {
    const Tag = createAnnotation<string>()

    @Tag('base')
    class Base {
      @Tag('base:run')
      run() {}
    }

    @Tag('sub')
    class Sub extends Base {
      @Tag('sub:go')
      go() {}
    }

    expect(reflect.get(Base, Tag)).toBe('base')
    expect(reflect.get(Base, Tag, 'go')).toBeUndefined()
    expect(reflect.get(Sub, Tag)).toBe('sub')
    expect(reflect.get(Sub, Tag, 'go')).toBe('sub:go')
    expect(reflect.get(Sub, Tag, 'run')).toBe('base:run')

    expect(Object.hasOwn(Sub[Symbol.metadata]!, Keys.kMetadata)).toBe(true)
    expect(storeOf(Sub)).not.toBe(storeOf(Base))
  })

  it('a subclass whose metadata the compiler linked to its base still gets its own store', function () {
    // tsc links every subclass's metadata object to its base's with Object.create; SWC only when
    // the subclass has a class decorator. Built by hand so the test depends on neither.
    const key = Symbol('k')
    class P {}
    class S extends P {}
    const parentMeta: DecoratorMetadata = Object.create(null)
    const childMeta: DecoratorMetadata = Object.create(parentMeta)
    Object.defineProperty(P, Symbol.metadata, { value: parentMeta, configurable: true })
    Object.defineProperty(S, Symbol.metadata, { value: childMeta, configurable: true })

    reflect.annotate({ kind: 'class', name: 'P', metadata: parentMeta } as ClassDecoratorContext, key, 'base')
    reflect.annotate({ kind: 'method', name: 'x', metadata: childMeta } as ClassMethodDecoratorContext, key, 'child')

    expect(Object.hasOwn(childMeta, Keys.kMetadata)).toBe(true)
    expect(childMeta[Keys.kMetadata]).not.toBe(parentMeta[Keys.kMetadata])
    expect((parentMeta[Keys.kMetadata] as Map<symbol, { members?: unknown }>).get(key)?.members).toBeUndefined()
    expect(reflect.get(P, key, 'x')).toBeUndefined()
    expect(reflect.get(S, key, 'x')).toBe('child')
    expect(reflect.get(S, key)).toBe('base')
  })
})

describe('inheritance', function () {
  const Tag = createAnnotation<string | undefined>()

  @Tag('base')
  class Base {
    @Tag('base:run')
    run() {}
  }

  it('an undecorated subclass reads its base through the constructor chain', function () {
    class Plain extends Base {}

    expect(Object.hasOwn(Plain, Symbol.metadata)).toBe(false)
    expect(reflect.get(Plain, Tag)).toBe('base')
    expect(reflect.get(Plain, Tag, 'run')).toBe('base:run')
  })

  it('a subclass decorated only on a member reads its base class slot', function () {
    // SWC leaves this subclass's metadata unlinked from its base's; the chain walk does not care.
    class Sub extends Base {
      @Tag('sub:other')
      other() {}
    }

    expect(reflect.get(Sub, Tag)).toBe('base')
    expect(reflect.get(Sub, Tag, 'other')).toBe('sub:other')
    expect(reflect.get(Sub, Tag, 'run')).toBe('base:run')
  })

  it('a decorated subclass shadows its base', function () {
    @Tag('sub')
    class Sub extends Base {
      @Tag('sub:run')
      override run() {}
    }

    expect(reflect.get(Sub, Tag)).toBe('sub')
    expect(reflect.get(Sub, Tag, 'run')).toBe('sub:run')
    expect(reflect.get(Base, Tag)).toBe('base')
    expect(reflect.get(Base, Tag, 'run')).toBe('base:run')
  })

  it('a method override without its own annotation carries the base method value', function () {
    class Sub extends Base {
      override run() {}
    }

    expect(reflect.get(Sub, Tag, 'run')).toBe('base:run')
  })

  it('a stored undefined counts as absent', function () {
    @Tag(undefined)
    class Sub extends Base {}

    expect(reflect.get(Sub, Tag)).toBe('base')
  })

  it('walks more than one level', function () {
    class Mid extends Base {}

    @Tag('leaf')
    class Leaf extends Mid {}

    expect(reflect.get(Leaf, Tag)).toBe('leaf')
    expect(reflect.get(Leaf, Tag, 'run')).toBe('base:run')
    expect(reflect.get(Mid, Tag)).toBe('base')
  })
})

describe('reflect.effective across the chain', function () {
  const RolesAnn = createAnnotation((...roles: string[]) => roles)

  class BaseCtrl {
    @RolesAnn('user:list')
    list() {}
  }

  @RolesAnn('admin')
  class AdminCtrl extends BaseCtrl {
    @RolesAnn('root')
    purge() {}

    other() {}
  }

  it('a base member slot beats the subclass class slot', function () {
    expect(reflect.effective(AdminCtrl, RolesAnn, 'list')).toEqual(['user:list'])
  })

  it('an own member slot wins', function () {
    expect(reflect.effective(AdminCtrl, RolesAnn, 'purge')).toEqual(['root'])
  })

  it('falls back to the nearest class slot', function () {
    expect(reflect.effective(AdminCtrl, RolesAnn, 'other')).toEqual(['admin'])
  })

  it('leaves the base untouched', function () {
    expect(reflect.get(BaseCtrl, RolesAnn)).toBeUndefined()
    expect(reflect.effective(BaseCtrl, RolesAnn, 'list')).toEqual(['user:list'])
  })
})

describe('reflect.merge across the chain', function () {
  const Perms = createAnnotation<string[]>()

  @Perms(['base'])
  class B {
    @Perms(['m'])
    run() {}
  }

  @Perms(['sub'])
  class S extends B {}

  it('does not accumulate the base class array', function () {
    expect(reflect.merge(S, Perms, 'run')).toEqual(['sub', 'm'])
    expect(reflect.merge(S, Perms, 'other')).toEqual(['sub'])
  })

  it('returns an empty array for a symbol key nothing declares', function () {
    expect(reflect.merge<string>(B, kRoles, 'run')).toEqual([])
  })
})

describe('module copies', function () {
  it('a second copy of di reads what the first one wrote', async function () {
    const Tag = createAnnotation<string>()

    @Tag('cls')
    @Roles('admin')
    class Owner {}

    vi.resetModules()
    const second = await import('../reflect.js')

    expect(second.reflect).not.toBe(reflect)
    expect(second.reflect.get<string[]>(Owner, kRoles)).toEqual(['admin'])
    expect(second.reflect.get(Owner, Tag)).toBe('cls')
  })
})
