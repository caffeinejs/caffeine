import { ResolutionContext } from '../../../resolution_context.js'
import { Factory } from '../../../factory.js'

export function functionFactory<T = unknown>(fn: (...args: unknown[]) => T): Factory<T> {
  return (ctx: ResolutionContext): T => {
    const resolvers = ctx.binding.injectionResolvers
    if (resolvers.length === 0) {
      return fn()
    }

    switch (resolvers.length) {
      case 1:
        return fn(resolvers[0]())
      case 2:
        return fn(resolvers[0](), resolvers[1]())
      case 3:
        return fn(resolvers[0](), resolvers[1](), resolvers[2]())
      case 4:
        return fn(resolvers[0](), resolvers[1](), resolvers[2](), resolvers[3]())
    }

    const deps = new Array(resolvers.length)
    for (let i = 0; i < resolvers.length; i++) {
      deps[i] = resolvers[i]()
    }

    return fn(...deps)
  }
}
