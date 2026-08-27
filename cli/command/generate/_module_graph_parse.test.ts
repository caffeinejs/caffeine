import { describe, expect, it } from 'bun:test'
import { hasDecorator, parseExportedConsts, parseRelativeImports } from './_module_graph_parse.js'

describe('module graph parse', () => {
  it('detects line-start decorators and ignores comment @see', () => {
    expect(hasDecorator('@Injectable() class A {}')).toBe(true)
    expect(hasDecorator('export class A {}\n@Injectable()\nexport class B {}')).toBe(true)
    expect(hasDecorator('// @see Something\nexport class D {}')).toBe(false)
  })

  it('collects relative runtime imports and skips import type', () => {
    const text = [
      'import { Foo } from \'../users/user.js\'',
      'import type { Bar } from \'../users/types.js\'',
      'import \'./local.js\'',
      'export { Baz } from \'../orders/baz.js\'',
      'import { X } from \'@caffeinejs/di\'',
      'import {\n  Q\n} from \'../cache/q.js\'',
    ].join('\n')

    expect(parseRelativeImports(text)).toEqual([
      '../users/user.js',
      '../orders/baz.js',
      '../cache/q.js',
      './local.js',
    ])
  })

  it('skips export type from', () => {
    expect(parseRelativeImports('export type { Foo } from \'../users/foo.js\'')).toEqual([])
  })

  it('collects exported const names', () => {
    expect(parseExportedConsts('export const ordersModule = 1\nexport const other = 2')).toEqual([
      'ordersModule',
      'other',
    ])
  })
})
