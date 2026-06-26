import { Tag } from '@caffeinejs/core'

export interface RouteParam {
  name: string
  type: 'path' | 'query' | 'body'
}

export function Params(params: RouteParam[]) {
  return function (target: Function, context: ClassMethodDecoratorContext): void {
    Tag(Symbol.for('controller:params'), new Map()
      .set(context.name, params))(target, context)
  }
}

export function Path(name: string): RouteParam {
  return { name, type: 'path' }
}

export function Query(name: string): RouteParam {
  return { name, type: 'query' }
}

export function Body(): RouteParam {
  return { name: 'body', type: 'body' }
}
