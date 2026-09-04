import { describe, expect, it } from 'bun:test'

import { parseDecoratedClasses, parseExportedConsts, parseRelativeImports } from './_module_graph_parse.js'

describe('module graph parse', () => {
  it('finds decorated classes in both TC39 decorator placements', () => {
    expect(parseDecoratedClasses('@Injectable()\nexport class A {}')).toEqual({ exported: ['A'], unexported: [] })
    expect(parseDecoratedClasses('export @Injectable() class B {}')).toEqual({ exported: ['B'], unexported: [] })
  })

  it('terminates decorator arguments on nested parens and strings', () => {
    const text = [
      "@Controller('/cats', [CatsService])",
      'export class CatsController {}',
      '',
      "@Injectable(token<Repo>('repo'))",
      'export class Repo {}',
    ].join('\n')

    expect(parseDecoratedClasses(text).exported).toEqual(['CatsController', 'Repo'])
  })

  it('ignores undecorated classes, comments, and member decorators', () => {
    expect(parseDecoratedClasses('export class Plain {}').exported).toEqual([])
    expect(parseDecoratedClasses('// @see Something\nexport class D {}').exported).toEqual([])
    expect(parseDecoratedClasses('export class Svc {\n  @Get("/")\n  find() {}\n}').exported).toEqual([])
  })

  it('reports a decorated class that cannot be named-imported', () => {
    expect(parseDecoratedClasses('@Injectable()\nclass Hidden {}')).toEqual({ exported: [], unexported: ['Hidden'] })
    expect(parseDecoratedClasses('@Injectable()\nexport default class Anon {}')).toEqual({
      exported: [],
      unexported: ['Anon'],
    })
  })

  it('does not leak a decorator onto a later undecorated class', () => {
    const text = '@Injectable()\nexport class A {}\n\nexport class B {}'
    expect(parseDecoratedClasses(text)).toEqual({ exported: ['A'], unexported: [] })
  })

  it('collects relative runtime imports and skips import type', () => {
    const text = [
      "import { Foo } from '../users/user.js'",
      "import type { Bar } from '../users/types.js'",
      "import './local.js'",
      "export { Baz } from '../orders/baz.js'",
      "import { X } from '@caffeinejs/di'",
      "import {\n  Q\n} from '../cache/q.js'",
    ].join('\n')

    expect(parseRelativeImports(text)).toEqual(['../users/user.js', '../orders/baz.js', '../cache/q.js', './local.js'])
  })

  it('skips export type from', () => {
    expect(parseRelativeImports("export type { Foo } from '../users/foo.js'")).toEqual([])
  })

  it('collects exported const names', () => {
    expect(parseExportedConsts('export const ordersModule = 1\nexport const other = 2')).toEqual([
      'ordersModule',
      'other',
    ])
  })
})
