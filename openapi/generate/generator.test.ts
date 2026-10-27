import { describe, expect, it } from 'vitest'

import { ErrOpenAPIConfiguration } from '../errors.js'
import type { OpenAPIDocument } from '../spec/spec.js'
import { validateDocument } from './generator.js'

function document(overrides: Partial<OpenAPIDocument>): OpenAPIDocument {
  return { openapi: '3.1.1', info: { title: 'API', version: '1.0.0' }, ...overrides }
}

// Each check stands in for a consumer's validator: finding the problem at boot is strictly better than a client
// generator rejecting the published document later.
describe('validateDocument', () => {
  it('accepts a document without paths', () => {
    expect(() => validateDocument(document({}))).not.toThrow()
  })

  it('refuses a document-level requirement naming an undefined scheme', () => {
    const invalid = document({ security: [{ Bearer: [] }], paths: {} })

    expect(() => validateDocument(invalid)).toThrow(ErrOpenAPIConfiguration)
    expect(() => validateDocument(invalid)).toThrow(
      'Cannot generate OpenAPI document: the document requires the security scheme "Bearer", ' +
        'which components.securitySchemes does not define',
    )
  })

  it('names the operation whose requirement is dangling, by its operationId or else its path', () => {
    const named = document({
      paths: { '/pets': { get: { operationId: 'listPets', security: [{ Key: [] }], responses: {} } } },
    })
    const anonymous = document({ paths: { '/pets': { get: { security: [{ Key: [] }], responses: {} } } } })

    expect(() => validateDocument(named)).toThrow('operation "listPets" requires the security scheme "Key"')
    expect(() => validateDocument(anonymous)).toThrow('operation "/pets" requires the security scheme "Key"')
  })

  it('accepts a requirement whose scheme is defined', () => {
    const valid = document({
      components: { securitySchemes: { Key: { type: 'apiKey', in: 'header', name: 'x-key' } } },
      paths: { '/pets': { get: { security: [{ Key: [] }], responses: {} } } },
    })

    expect(() => validateDocument(valid)).not.toThrow()
  })

  it('refuses a path template placeholder no operation declares', () => {
    const invalid = document({ paths: { '/pets/{id}': { get: { operationId: 'getPet', responses: {} } } } })

    expect(() => validateDocument(invalid)).toThrow(ErrOpenAPIConfiguration)
    expect(() => validateDocument(invalid)).toThrow('path "/pets/{id}" declares no parameter for "{id}"')
  })

  it('checks operations held under additionalOperations too', () => {
    const invalid = document({
      openapi: '3.2.0',
      paths: { '/pets/{id}': { additionalOperations: { QUERY: { operationId: 'queryPet', responses: {} } } } },
    })

    expect(() => validateDocument(invalid)).toThrow('path "/pets/{id}" declares no parameter for "{id}"')
  })

  // A path item may carry only shared parameters and no operation; there is nothing yet to be invalid.
  it('accepts a placeholder on a path item with no operations', () => {
    expect(() => validateDocument(document({ paths: { '/pets/{id}': {} } }))).not.toThrow()
  })
})
