import { $t } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { kBuild, OpenAPIOptionsBuilder } from './options_builder.js'

describe('OpenAPIOptionsBuilder', () => {
  it('builds the defaults when nothing is set', () => {
    const options = new OpenAPIOptionsBuilder()[kBuild]()

    expect(options.version).toBe('3.1.1')
    expect(options.info).toEqual({ title: 'API', version: '0.0.0' })
    expect(options.routes).toEqual({ base: '/', json: '/openapi.json', yaml: '/openapi.yaml', docs: '/docs' })
    expect(options.deriveSecuritySchemes).toBe(true)
    expect(options.dedupeComponents).toBe(false)
    expect(options.validate).toBe(undefined)
    expect(options.ui).toBe(undefined)
  })

  it('carries every document-level fact into the options', () => {
    const options = new OpenAPIOptionsBuilder()
      .server('https://api.example.com', 'Production')
      .server({ url: 'https://staging.example.com' })
      .externalDocs({ url: 'https://docs.example.com' })
      .security({ Bearer: [] }, { Key: [] })
      .tag({ name: 'Pets' })
      .tag({ name: 'Stores' })
      [kBuild]()

    expect(options.servers).toEqual([
      { url: 'https://api.example.com', description: 'Production' },
      { url: 'https://staging.example.com' },
    ])
    expect(options.externalDocs).toEqual({ url: 'https://docs.example.com' })
    expect(options.security).toEqual([{ Bearer: [] }, { Key: [] }])
    expect(options.tags).toEqual([{ name: 'Pets' }, { name: 'Stores' }])
  })

  // Each call adds a scheme; the second must not erase the first.
  it('accumulates declared security schemes by name', () => {
    const options = new OpenAPIOptionsBuilder()
      .securityScheme('Key', { type: 'apiKey', in: 'header', name: 'x-key' })
      .securityScheme('Basic', { type: 'http', scheme: 'basic' })
      [kBuild]()

    expect(options.securitySchemes).toEqual({
      Key: { type: 'apiKey', in: 'header', name: 'x-key' },
      Basic: { type: 'http', scheme: 'basic' },
    })
  })

  it('turns derivation, deduplication and validation on with no argument, and off with false', () => {
    const on = new OpenAPIOptionsBuilder().deriveSecuritySchemes().dedupeComponents().validate()[kBuild]()
    const off = new OpenAPIOptionsBuilder()
      .deriveSecuritySchemes(false)
      .dedupeComponents(false)
      .validate(false)
      [kBuild]()

    expect([on.deriveSecuritySchemes, on.dedupeComponents, on.validate]).toEqual([true, true, true])
    expect([off.deriveSecuritySchemes, off.dedupeComponents, off.validate]).toEqual([false, false, false])
  })

  // Setting one inference or status must keep the defaults of the others, or a single call would silently
  // switch off the 401/403 inference.
  it('merges inference and error statuses over the defaults, key by key', () => {
    const options = new OpenAPIOptionsBuilder().infer({ auth: false }).errors({ validation: 422 })[kBuild]()

    expect(options.infer).toEqual({ validation: true, auth: false })
    expect(options.errors).toEqual({ validation: 422, unauthorized: 401, forbidden: 403 })
  })

  it('keeps the error schema and the naming overrides it was given', () => {
    const errorSchema = $t.Object({ message: $t.String() })
    const operationId = () => 'op'
    const tagFor = () => 'Tag'

    const options = new OpenAPIOptionsBuilder()
      .errorSchema(errorSchema)
      .operationId(operationId)
      .tagFor(tagFor)
      [kBuild]()

    expect(options.errorSchema).toBe(errorSchema)
    expect(options.operationId).toBe(operationId)
    expect(options.tagFor).toBe(tagFor)
  })

  it('switches the YAML and UI endpoints off with false', () => {
    const options = new OpenAPIOptionsBuilder().yaml(false).docs(false)[kBuild]()

    expect(options.routes).toEqual({ base: '/', json: '/openapi.json', yaml: undefined, docs: undefined })
  })

  describe('secure', () => {
    it('takes a scheme name as shorthand', () => {
      const options = new OpenAPIOptionsBuilder().secure('Basic')[kBuild]()

      expect(options.secure).toEqual({ schemes: ['Basic'] })
      expect(options.secureExplicit).toBe(true)
    })

    // The endpoints must require an authenticated user even when the callback names nothing.
    it('compiles a callback that names nothing to the bare authenticated-user requirement', () => {
      const options = new OpenAPIOptionsBuilder().secure(() => undefined)[kBuild]()

      expect(options.secure).toEqual({})
    })

    it('lets a later public() undo it', () => {
      const options = new OpenAPIOptionsBuilder().secure('Basic').public()[kBuild]()

      expect(options.secure).toBe(undefined)
      expect(options.secureExplicit).toBe(true)
    })
  })
})
