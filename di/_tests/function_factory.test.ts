import { describe, it, expect } from 'vitest'
import { token } from '../key.js'
import { Injectable } from '../decorators/injectable.js'
import { CaffeineIoC } from '../container.js'
import { $i } from '../injection.js'

describe('Functions', function () {
  describe('given a function that returns another function', function () {
    const kVal = token<any>(Symbol('test'))

    class Opt {}

    @Injectable()
    class Dep {
      value = 'test'
    }

    @Injectable(kVal)
    class Nm {
      id = 'dev'
    }

    it('should resolve functions injecting required dependencies', async function () {
      const di = new CaffeineIoC()
      const kFn = token<any>(Symbol('fn'))
      const fn = (dep: Dep, nm: Nm, opt?: Opt) => (message: string) =>
        `received: ${message} - ${dep.value} - ${nm.id} - ${opt === undefined}`

      di.bind(kFn, t => t
        .toFunction(fn, [Dep, kVal, $i.optional(Opt)]))
      await di.init()

      const theFunction = di.get<(message: string) => string>(kFn)
      const res = theFunction('hello')

      expect(res)
        .toEqual('received: hello - test - dev - true')
    })
  })

  describe('given a function that returns an object with functions', function () {
    it('should resolve function that returns an object with functions', async function () {
      @Injectable()
      class Msg {
        msg() {
          return 'hello'
        }
      }

      const kFn = token<any>(Symbol('fn'))
      const fn = (msg: Msg) => ({
        greet: () => msg.msg() + ' world',
      })

      const di = new CaffeineIoC()
      di.bind(kFn, t => t
        .toFunction(fn, [Msg]))
      await di.init()

      const obj = di.get<{ greet: () => string }>(kFn)
      const res = obj.greet()

      expect(res)
        .toEqual('hello world')
    })
  })

  describe('given a function with 0 dependencies', function () {
    it('should resolve without arguments', async function () {
      const kFn = token<any>(Symbol('fn-no-deps'))
      const fn = () => 'no deps'

      const di = new CaffeineIoC()
      di.bind(kFn, t => t
        .toFunction(fn))
      await di.init()

      const result = di.get<string>(kFn)

      expect(result)
        .toEqual('no deps')
    })
  })

  describe('given a function with 2 dependencies', function () {
    it('should resolve with 2 arguments', async function () {
      const kFn = token<any>(Symbol('fn-2-deps'))
      const fn = (a: string, b: string) => `${a}-${b}`

      const di = new CaffeineIoC()
      di.bind(token<any>('fn2-dep-a'), t => t
        .toValue('alpha'))
      di.bind(token<any>('fn2-dep-b'), t => t
        .toValue('beta'))
      di.bind(kFn, t => t
        .toFunction(fn, [token<any>('fn2-dep-a'), token<any>('fn2-dep-b')]))
      await di.init()

      const result = di.get<string>(kFn)

      expect(result)
        .toEqual('alpha-beta')
    })
  })

  describe('given a function with 4 dependencies', function () {
    it('should resolve with 4 arguments', async function () {
      const kFn = token<any>(Symbol('fn-4-deps'))
      const fn = (a: string, b: string, c: string, d: string) => `${a}-${b}-${c}-${d}`

      const di = new CaffeineIoC()
      di.bind(token<any>('fn4-dep-a'), t => t
        .toValue('a'))
      di.bind(token<any>('fn4-dep-b'), t => t
        .toValue('b'))
      di.bind(token<any>('fn4-dep-c'), t => t
        .toValue('c'))
      di.bind(token<any>('fn4-dep-d'), t => t
        .toValue('d'))
      di.bind(kFn, t => t
        .toFunction(fn, [token<any>('fn4-dep-a'), token<any>('fn4-dep-b'), token<any>('fn4-dep-c'), token<any>('fn4-dep-d')]))
      await di.init()

      const result = di.get<string>(kFn)

      expect(result)
        .toEqual('a-b-c-d')
    })
  })

  describe('given a function with 5 or more dependencies', function () {
    it('should resolve via fallback array path', async function () {
      const kFn = token<any>(Symbol('fn-5-deps'))
      const fn = (a: string, b: string, c: string, d: string, e: string) =>
        `${a}-${b}-${c}-${d}-${e}`

      const di = new CaffeineIoC()
      di.bind(token<any>('fn5-dep-a'), t => t
        .toValue('a'))
      di.bind(token<any>('fn5-dep-b'), t => t
        .toValue('b'))
      di.bind(token<any>('fn5-dep-c'), t => t
        .toValue('c'))
      di.bind(token<any>('fn5-dep-d'), t => t
        .toValue('d'))
      di.bind(token<any>('fn5-dep-e'), t => t
        .toValue('e'))
      di.bind(kFn, t => t
        .toFunction(fn, [token<any>('fn5-dep-a'), token<any>('fn5-dep-b'), token<any>('fn5-dep-c'), token<any>('fn5-dep-d'), token<any>('fn5-dep-e')]))
      await di.init()

      const result = di.get<string>(kFn)

      expect(result)
        .toEqual('a-b-c-d-e')
    })
  })
})
