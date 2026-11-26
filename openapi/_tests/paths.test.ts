import { describe, expect, it } from 'vitest'

import { templateParameters, translatePath } from '../generate/paths.js'

describe('translatePath', () => {
  it('preserves an unmatched closing parenthesis before a constrained parameter', () => {
    expect(translatePath('/pets/)/:id(^\\d+$)')).toEqual({
      templates: ['/pets/)/{id}'],
      parameters: [{ name: 'id', pattern: '\\d+' }],
    })
  })

  it('keeps grouped and escaped constraints with their parameter', () => {
    expect(translatePath('/pets/:id(^a(b|c)\\(d\\)$)')).toEqual({
      templates: ['/pets/{id}'],
      parameters: [{ name: 'id', pattern: 'a(b|c)\\(d\\)' }],
    })
  })

  // The router refuses an unclosed constraint when the route registers: reading one here takes time linear in it.
  it('reads an unclosed constraint in time linear in the path', () => {
    const path = '/' + ':id(('.repeat(20_000)
    const started = performance.now()
    expect(translatePath(path).parameters).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('leaves a static path alone', () => {
    expect(translatePath('/pets')).toEqual({ templates: ['/pets'], parameters: [] })
  })

  it('rewrites a named parameter', () => {
    expect(translatePath('/pets/:id')).toEqual({
      templates: ['/pets/{id}'],
      parameters: [{ name: 'id', pattern: undefined }],
    })
  })

  it('rewrites several parameters across segments', () => {
    const result = translatePath('/users/:userId/orders/:orderId')

    expect(result.templates).toEqual(['/users/{userId}/orders/{orderId}'])
    expect(result.parameters.map(p => p.name)).toEqual(['userId', 'orderId'])
  })

  it('splits two parameters sharing one segment', () => {
    const result = translatePath('/files/:file.:ext')

    expect(result.templates).toEqual(['/files/{file}.{ext}'])
    expect(result.parameters.map(p => p.name)).toEqual(['file', 'ext'])
  })

  it('lifts an inline regex onto the parameter and strips its anchors', () => {
    const result = translatePath('/pets/:id(^\\d+$)')

    expect(result.templates).toEqual(['/pets/{id}'])
    expect(result.parameters).toEqual([{ name: 'id', pattern: '\\d+' }])
  })

  it('emits two templates for an optional parameter', () => {
    const result = translatePath('/pets/:id?')

    expect(result.templates).toEqual(['/pets', '/pets/{id}'])
    expect(result.parameters.map(p => p.name)).toEqual(['id'])
  })

  it('renames a wildcard, which is not a legal template name', () => {
    const result = translatePath('/assets/*')

    expect(result.templates).toEqual(['/assets/{wildcard}'])
    expect(result.parameters).toEqual([{ name: 'wildcard', wildcard: true }])
  })
})

describe('templateParameters', () => {
  it('stops scanning when many opening braces have no closing brace', () => {
    const started = performance.now()
    expect(templateParameters('/{id}/' + '{'.repeat(100_000))).toEqual(['id'])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('preserves nonempty names and ignores empty placeholders', () => {
    expect(templateParameters('/{}/{a{b}/{id}')).toEqual(['a{b', 'id'])
  })

  it('reads the names a template references, in order', () => {
    expect(templateParameters('/users/{userId}/orders/{orderId}')).toEqual(['userId', 'orderId'])
  })

  it('is empty for a static template', () => {
    expect(templateParameters('/pets')).toEqual([])
  })
})
