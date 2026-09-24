import { describe, expect, it } from 'bun:test'

import { parseDecoratedClasses, parseExportedConsts, parseRelativeImports } from './_module_graph_parse.js'

const DI = "import { Injectable } from '@caffeinejs/di'"
const HTTP = "import { Catch, Controller } from '@caffeinejs/http'"

describe('module graph parse', () => {
  it('finds decorated classes in both TC39 decorator placements', () => {
    expect(parseDecoratedClasses(`${DI}\n@Injectable()\nexport class A {}`)).toEqual({
      exported: ['A'],
      unexported: [],
      foreign: [],
    })
    expect(parseDecoratedClasses(`${DI}\nexport @Injectable() class B {}`)).toEqual({
      exported: ['B'],
      unexported: [],
      foreign: [],
    })
  })

  it('terminates decorator arguments on nested parens and strings', () => {
    const text = [
      HTTP,
      "import { Injectable, token } from '@caffeinejs/di'",
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
    expect(parseDecoratedClasses(`${HTTP}\nexport class Svc {\n  @Get("/")\n  find() {}\n}`).exported).toEqual([])
  })

  it('reports a decorated class that cannot be named-imported', () => {
    expect(parseDecoratedClasses(`${DI}\n@Injectable()\nclass Hidden {}`)).toEqual({
      exported: [],
      unexported: ['Hidden'],
      foreign: [],
    })
    expect(parseDecoratedClasses(`${DI}\n@Injectable()\nexport default class Anon {}`)).toEqual({
      exported: [],
      unexported: ['Anon'],
      foreign: [],
    })
  })

  it('does not leak a decorator onto a later undecorated class', () => {
    const text = `${DI}\n@Injectable()\nexport class A {}\n\nexport class B {}`
    expect(parseDecoratedClasses(text)).toEqual({ exported: ['A'], unexported: [], foreign: [] })
  })

  // The container never builds a TypeORM entity: it is constructed by the data source, and its file is
  // compiled apart. Listing it would also make the generated module import it.
  it('leaves a class decorated only by another library alone, without warning', () => {
    const text = ["import { Entity } from 'typeorm'", "@Entity('customers')", 'export class CustomerEntity {}'].join(
      '\n',
    )

    expect(parseDecoratedClasses(text)).toEqual({ exported: [], unexported: [], foreign: [] })
  })

  // fetchy's @API only records a declaration; FetchyClient.create() implements it, so a binding would
  // hand callers a class the container cannot build.
  it('leaves a fetchy API declaration alone', () => {
    const text = [
      "import { API, ContentType, Path } from '@caffeinejs/fetchy'",
      '@API()',
      "@Path('/admin')",
      '@ContentType(MediaTypes.JSON)',
      'export class KeycloakAdminAPI {}',
    ].join('\n')

    expect(parseDecoratedClasses(text)).toEqual({ exported: [], unexported: [], foreign: [] })
  })

  // @APIGroup only annotates the route group; it never reaches defineInjectable.
  it('separates a descriptive Caffeine decorator from a registering one', () => {
    const openapi = "import { APIGroup } from '@caffeinejs/openapi'"

    expect(parseDecoratedClasses(`${openapi}\n@APIGroup('pets')\nexport class Docs {}`).exported).toEqual([])
    expect(
      parseDecoratedClasses(`${openapi}\n${HTTP}\n@APIGroup('pets')\n@Controller('/pets')\nexport class Pets {}`)
        .exported,
    ).toEqual(['Pets'])
  })

  it('registers a class-level @Catch handler', () => {
    expect(parseDecoratedClasses(`${HTTP}\n@Catch(Error)\nexport class Handler {}`).exported).toEqual(['Handler'])
  })

  it('resolves an aliased and a namespaced decorator import', () => {
    const aliased = "import { Controller as Ctrl } from '@caffeinejs/http'"
    expect(parseDecoratedClasses(`${aliased}\n@Ctrl('/cats')\nexport class Cats {}`).exported).toEqual(['Cats'])

    const namespaced = "import * as di from '@caffeinejs/di'"
    expect(parseDecoratedClasses(`${namespaced}\n@di.Injectable()\nexport class Svc {}`).exported).toEqual(['Svc'])
  })

  it('resolves a decorator imported from a package subpath', () => {
    const text = "import { Injectable } from '@caffeinejs/di/internals'\n@Injectable()\nexport class Svc {}"
    expect(parseDecoratedClasses(text).exported).toEqual(['Svc'])
  })

  // The one case where a class silently stops being provided, so the caller warns about it.
  it('reports a registering name that does not come from its Caffeine package', () => {
    expect(parseDecoratedClasses('@Injectable()\nexport class Local {}')).toEqual({
      exported: [],
      unexported: [],
      foreign: [{ name: 'Local', decorator: 'Injectable' }],
    })
    expect(
      parseDecoratedClasses("import { Controller } from './decorators.js'\n@Controller()\nexport class C {}"),
    ).toEqual({ exported: [], unexported: [], foreign: [{ name: 'C', decorator: 'Controller' }] })
  })

  it('does not bind a type-only import', () => {
    const text = "import type { Injectable } from '@caffeinejs/di'\n@Injectable()\nexport class A {}"
    expect(parseDecoratedClasses(text)).toEqual({
      exported: [],
      unexported: [],
      foreign: [{ name: 'A', decorator: 'Injectable' }],
    })
  })

  it('resolves a decorator through an import clause longer than the FROM_SRC bound', () => {
    const filler = Array.from({ length: 60 }, (_, index) => `Name${index}`).join(', ')
    expect(filler.length).toBeGreaterThan(400)

    const text = `import { ${filler}, Controller } from '@caffeinejs/http'\n@Controller('/x')\nexport class C {}`
    expect(parseDecoratedClasses(text).exported).toEqual(['C'])
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
