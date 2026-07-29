import { Ctor } from '../../../types.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Factory } from '../../../factory.js'
import { InjectionResolver } from '../../../injection_resolver.js'

export function classFactory<T = any>(clazz: Ctor<T>, resolvers: InjectionResolver<unknown>[] = []): Factory<T> {
  switch (resolvers.length) {
    case 0:
      return (_ctx: ResolutionContext): T => new clazz()
    case 1: {
      const r0 = resolvers[0]
      return (_ctx: ResolutionContext): T => new clazz(r0())
    }
    case 2: {
      const r0 = resolvers[0]
      const r1 = resolvers[1]
      return (_ctx: ResolutionContext): T => new clazz(r0(), r1())
    }
    case 3: {
      const r0 = resolvers[0]
      const r1 = resolvers[1]
      const r2 = resolvers[2]
      return (_ctx: ResolutionContext): T => new clazz(r0(), r1(), r2())
    }
    case 4: {
      const r0 = resolvers[0]
      const r1 = resolvers[1]
      const r2 = resolvers[2]
      const r3 = resolvers[3]
      return (_ctx: ResolutionContext): T => new clazz(r0(), r1(), r2(), r3())
    }
    default: {
      const rs = resolvers.slice()
      return (_ctx: ResolutionContext): T => {
        const p = new Array(rs.length)
        for (let i = 0; i < rs.length; i++) {
          p[i] = rs[i]()
        }
        return new clazz(...p)
      }
    }
  }
}
