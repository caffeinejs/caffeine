import { ErrCaffeineWebApplication } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'

import { DEFAULT_DOCUMENT_NAME } from './_default_name.js'

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
      errMessage(
        `Cannot generate OpenAPI document: duplicate operationId "${operationId}" on "${first}" and "${second}"`,
      )
        .reference('@caffeinejs/openapi', ErrOpenAPIOperationConflict)
        .build(),
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
      errMessage(`Cannot generate OpenAPI document: two different schemas share the component name "${name}"`)
        .reference('@caffeinejs/openapi', ErrOpenAPISchemaConflict)
        .build(),
      'ERR_OPENAPI_SCHEMA_CONFLICT',
    )
    this.name = 'ErrOpenAPISchemaConflict'
  }
}

/**
 * `OpenAPIProvider.docs(name)` named a document no `openapi(...)` plugin registered.
 *
 * The message lists the names that are registered, since the usual cause is a typo or a plugin added to another
 * application.
 */
export class ErrOpenAPIDocumentNotFound extends ErrCaffeineWebApplication {
  constructor(name: string, registered: readonly string[]) {
    const plugin = name === DEFAULT_DOCUMENT_NAME ? 'openapi()' : `openapi("${name}")`
    const names = registered.map(n => `"${n}"`).join(', ')

    super(
      errMessage(`Cannot find the OpenAPI document "${name}": no openapi() plugin has registered it`)
        .solutions(
          registered.length === 0
            ? `Register it with .with(${plugin}) on the application`
            : `Ask for one of the registered documents: ${names}`,
          'Read it after await app.bootstrap() or app.run() resolves, once every plugin has registered its document',
        )
        .reference('@caffeinejs/openapi', ErrOpenAPIDocumentNotFound)
        .build(),
      'ERR_OPENAPI_DOCUMENT_NOT_FOUND',
    )
    this.name = 'ErrOpenAPIDocumentNotFound'
  }
}

/**
 * `OpenAPIProvider.docs(name)` was called before the server finished starting.
 *
 * A document is generated once every route has registered, when the server is ready, so it does not exist while
 * the application is still being set up.
 */
export class ErrOpenAPIDocumentNotReady extends ErrCaffeineWebApplication {
  constructor(name: string) {
    super(
      errMessage(`Cannot read the OpenAPI document "${name}": it is generated when the server is ready`)
        .solutions('Read it after await app.bootstrap() or app.run() resolves')
        .reference('@caffeinejs/openapi', ErrOpenAPIDocumentNotReady)
        .build(),
      'ERR_OPENAPI_DOCUMENT_NOT_READY',
    )
    this.name = 'ErrOpenAPIDocumentNotReady'
  }
}

/**
 * `OpenAPIProvider.docs()` was called without a name while several documents, none of them `default`, are
 * registered. Returning any one of them would be a guess.
 */
export class ErrOpenAPIDocumentAmbiguous extends ErrCaffeineWebApplication {
  constructor(registered: readonly string[]) {
    const reads = registered.map(n => `docs("${n}")`).join(', ')

    super(
      errMessage(`Cannot choose an OpenAPI document: ${registered.length} are registered and none is named "default"`)
        .solutions(`Name the one to read: ${reads}`)
        .reference('@caffeinejs/openapi', ErrOpenAPIDocumentAmbiguous)
        .build(),
      'ERR_OPENAPI_DOCUMENT_AMBIGUOUS',
    )
    this.name = 'ErrOpenAPIDocumentAmbiguous'
  }
}
