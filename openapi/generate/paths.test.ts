import { describe, expect, it } from 'vitest'

import { translatePath } from './paths.js'

describe('translatePath', () => {
  // Without the optional segment a root route is "/", never the empty string, which is not a valid path key.
  it('turns an optional parameter at the root into the root path and the parameterized one', () => {
    expect(translatePath('/:id?')).toEqual({
      templates: ['/', '/{id}'],
      parameters: [{ name: 'id', pattern: undefined }],
    })
  })

  // The document names each path as the router serves it, and each parameter the router fills.
  it.each([
    ['/teams/:$team/jobs', ['/teams/{$team}/jobs'], [{ name: '$team', pattern: undefined }]],
    ['/service::name/jobs', ['/service:name/jobs'], []],
    [
      '/at/:lat-:lng?',
      ['/at', '/at/{lat}-{lng}'],
      [
        { name: 'lat', pattern: undefined },
        { name: 'lng', pattern: undefined },
      ],
    ],
    ['/d/:p((a|b)/c)', ['/d/{p}'], [{ name: 'p', pattern: '(a|b)/c' }]],
    ['/reports/:id.json?', ['/reports', '/reports/{id}.json'], [{ name: 'id', pattern: undefined }]],
    ['/download/:id-file*name', ['/download/{id}-file*name'], [{ name: 'id', pattern: undefined }]],
    // The shorter path keeps what precedes the optional segment as the router serves it.
    ['/a//:id?', ['/a/', '/a//{id}'], [{ name: 'id', pattern: undefined }]],
    ['/pets/:id?/', ['/pets/', '/pets/{id}/'], [{ name: 'id', pattern: undefined }]],
    // An escaped colon starts an optional segment of text alone: the parameter before it stays.
    ['/:tenant/::summary?', ['/{tenant}', '/{tenant}/:summary'], [{ name: 'tenant', pattern: undefined }]],
  ])('translates %s as the router reads it', (path, templates, parameters) => {
    expect(translatePath(path)).toEqual({ templates, parameters })
  })
})
