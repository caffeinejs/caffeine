import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Provides } from '../decorators/provides.js'

describe('@Configuration bean factory', function () {
  describe('with 2 injected dependencies', function () {
    @Injectable()
    class Dep2A {
      readonly val = 'a'
    }

    @Injectable()
    class Dep2B {
      readonly val = 'b'
    }

    class Svc2 {
      constructor(
        readonly a: string,
        readonly b: string,
      ) {}
    }

    @Configuration()
    class Conf2 {
      @Provides(Svc2, [Dep2A, Dep2B])
      svc(a: Dep2A, b: Dep2B): Svc2 {
        return new Svc2(a.val, b.val)
      }
    }

    void Conf2

    it('resolves bean with 2 dependencies', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const svc = di.get(Svc2)
      expect(svc.a).toEqual('a')
      expect(svc.b).toEqual('b')
    })
  })

  describe('with 3 injected dependencies', function () {
    @Injectable()
    class Dep3A {
      readonly val = 'a'
    }

    @Injectable()
    class Dep3B {
      readonly val = 'b'
    }

    @Injectable()
    class Dep3C {
      readonly val = 'c'
    }

    class Svc3 {
      constructor(
        readonly a: string,
        readonly b: string,
        readonly c: string,
      ) {}
    }

    @Configuration()
    class Conf3 {
      @Provides(Svc3, [Dep3A, Dep3B, Dep3C])
      svc(a: Dep3A, b: Dep3B, c: Dep3C): Svc3 {
        return new Svc3(a.val, b.val, c.val)
      }
    }

    void Conf3

    it('resolves bean with 3 dependencies', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const svc = di.get(Svc3)
      expect(svc.a).toEqual('a')
      expect(svc.b).toEqual('b')
      expect(svc.c).toEqual('c')
    })
  })

  describe('with 4 injected dependencies', function () {
    @Injectable()
    class Dep4A {
      readonly val = 'a'
    }

    @Injectable()
    class Dep4B {
      readonly val = 'b'
    }

    @Injectable()
    class Dep4C {
      readonly val = 'c'
    }

    @Injectable()
    class Dep4D {
      readonly val = 'd'
    }

    class Svc4 {
      constructor(
        readonly a: string,
        readonly b: string,
        readonly c: string,
        readonly d: string,
      ) {}
    }

    @Configuration()
    class Conf4 {
      @Provides(Svc4, [Dep4A, Dep4B, Dep4C, Dep4D])
      svc(a: Dep4A, b: Dep4B, c: Dep4C, d: Dep4D): Svc4 {
        return new Svc4(a.val, b.val, c.val, d.val)
      }
    }

    void Conf4

    it('resolves bean with 4 dependencies', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const svc = di.get(Svc4)
      expect(svc.a).toEqual('a')
      expect(svc.b).toEqual('b')
      expect(svc.c).toEqual('c')
      expect(svc.d).toEqual('d')
    })
  })

  describe('with 5 or more injected dependencies', function () {
    @Injectable()
    class Dep5A {
      readonly val = 'a'
    }

    @Injectable()
    class Dep5B {
      readonly val = 'b'
    }

    @Injectable()
    class Dep5C {
      readonly val = 'c'
    }

    @Injectable()
    class Dep5D {
      readonly val = 'd'
    }

    @Injectable()
    class Dep5E {
      readonly val = 'e'
    }

    class Svc5 {
      constructor(
        readonly a: string,
        readonly b: string,
        readonly c: string,
        readonly d: string,
        readonly e: string,
      ) {}
    }

    @Configuration()
    class Conf5 {
      @Provides(Svc5, [Dep5A, Dep5B, Dep5C, Dep5D, Dep5E])
      svc(a: Dep5A, b: Dep5B, c: Dep5C, d: Dep5D, e: Dep5E): Svc5 {
        return new Svc5(a.val, b.val, c.val, d.val, e.val)
      }
    }

    void Conf5

    it('resolves bean via fallback array path with 5 dependencies', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const svc = di.get(Svc5)
      expect(svc.a).toEqual('a')
      expect(svc.b).toEqual('b')
      expect(svc.c).toEqual('c')
      expect(svc.d).toEqual('d')
      expect(svc.e).toEqual('e')
    })
  })
})
