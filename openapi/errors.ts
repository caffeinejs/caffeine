import { ErrCaffeineWebApplication } from '@caffeinejs/http'

/**
 * A configuration that cannot produce a correct document, detected while the application is starting.
 *
 * Every use is a boot-time failure by design: a malformed OpenAPI document is not something a consumer can
 * recover from at request time, and a document that silently omits a route is worse than one that never
 * shipped. The framework already fails before `listen()` on an unconvertible route schema; this matches it.
 */
export class ErrOpenAPIConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_OPENAPI_CONFIGURATION')
    this.name = 'ErrOpenAPIConfiguration'
  }
}

/**
 * Two operations claimed the same `operationId`.
 *
 * Client generators key their emitted method names off `operationId`, so a duplicate silently overwrites one
 * of the two — the caller then gets a method that calls the wrong endpoint. Naming both sites is the whole
 * value of the error, since the default is derived and neither site mentions the id.
 */
export class ErrOpenAPIOperationConflict extends ErrCaffeineWebApplication {
  constructor(operationId: string, first: string, second: string) {
    super(
      `Cannot generate OpenAPI document: duplicate operationId "${operationId}" on "${first}" and "${second}"`,
      'ERR_OPENAPI_OPERATION_CONFLICT',
    )
    this.name = 'ErrOpenAPIOperationConflict'
  }
}

/**
 * Two structurally different schemas were hoisted under the same component name.
 *
 * Names come from a schema's `$id`, so this means two `$t` declarations share one id. Emitting either would
 * misdescribe every route that references the other.
 */
export class ErrOpenAPISchemaConflict extends ErrCaffeineWebApplication {
  constructor(name: string) {
    super(
      `Cannot generate OpenAPI document: two different schemas share the component name "${name}"`,
      'ERR_OPENAPI_SCHEMA_CONFLICT',
    )
    this.name = 'ErrOpenAPISchemaConflict'
  }
}
