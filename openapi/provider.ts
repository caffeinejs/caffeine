import { errMessage } from '@caffeinejs/std/err'

import { DEFAULT_DOCUMENT_NAME } from './_default_name.js'
import {
  ErrOpenAPIConfiguration,
  ErrOpenAPIDocumentAmbiguous,
  ErrOpenAPIDocumentNotFound,
  ErrOpenAPIDocumentNotReady,
} from './errors.js'
import type { OpenAPIDocument } from './spec/spec.js'

/** Claims a document name while the plugin that will generate it is set up. Package-internal. */
export const kReserve = Symbol('caffeine.openapi.reserve')

/** Stores a reserved document once it is generated. Package-internal. */
export const kPublish = Symbol('caffeine.openapi.publish')

/**
 * The OpenAPI documents an application generates, by name. `.install(OpenAPI())` binds it, and each
 * `.with(openapi(...))` registers one document into it.
 *
 * Inject it, or resolve it with its class as the key, wherever a component needs the document rather than the HTTP
 * endpoint that serves it:
 *
 * ```ts
 * await app.bootstrap()
 * setOpenapiSchema(app.container.get(OpenAPIProvider).docs())
 * ```
 */
export class OpenAPIProvider {
  // `undefined` while the plugin is set up and the server is not ready yet.
  readonly #documents = new Map<string, OpenAPIDocument | undefined>()
  /** The `openapi(...)` declaration that reserved each name. */
  readonly #reservedBy = new Map<string, object>()

  /**
   * The document registered under `name`, exactly as it is served.
   *
   * Without a name, the one named `default`, else the only one registered. The document is frozen: it is the
   * object every endpoint serves, and a consumer changing it would change what they serve.
   *
   * @throws ErrOpenAPIDocumentNotFound when no plugin registered the name.
   * @throws ErrOpenAPIDocumentNotReady when called before the server is ready, which is when documents are generated.
   * @throws ErrOpenAPIDocumentAmbiguous when no name is given, several documents are registered, and none is
   *   `default`.
   */
  docs(name?: string): OpenAPIDocument {
    const resolved = name ?? this.#defaultName()

    if (!this.#documents.has(resolved)) {
      throw new ErrOpenAPIDocumentNotFound(resolved, [...this.#documents.keys()])
    }

    const document = this.#documents.get(resolved)
    if (document === undefined) {
      throw new ErrOpenAPIDocumentNotReady(resolved)
    }

    return document
  }

  /**
   * @param by - The `openapi(...)` declaration reserving it: one that runs again, at a second place, is told so.
   * @throws ErrOpenAPIConfiguration when a plugin already claimed the name.
   */
  [kReserve](name: string, by: object): void {
    const holder = this.#reservedBy.get(name)
    if (holder === by) {
      throw new ErrOpenAPIConfiguration(
        errMessage(
          `Cannot register the OpenAPI document "${name}": the openapi() that registers it serves at more than one place`,
        )
          .solutions(
            'Mount the router or controller that registers openapi(...) at one place',
            'Or register openapi(...) on the application or a listener, where it runs once',
          )
          .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
          .build(),
      )
    }

    if (holder !== undefined) {
      throw new ErrOpenAPIConfiguration(
        errMessage(`Cannot register the OpenAPI document "${name}": another openapi() plugin already registered it`)
          .solutions(
            'Give each document its own name, such as .with(openapi("admin", o => ...))',
            'Remove the duplicate .with(openapi(...)) call',
          )
          .reference('@caffeinejs/openapi', ErrOpenAPIConfiguration)
          .build(),
      )
    }

    this.#documents.set(name, undefined)
    this.#reservedBy.set(name, by)
  }

  [kPublish](name: string, document: OpenAPIDocument): void {
    this.#documents.set(name, document)
  }

  #defaultName(): string {
    if (this.#documents.has(DEFAULT_DOCUMENT_NAME) || this.#documents.size === 0) {
      return DEFAULT_DOCUMENT_NAME
    }

    const names = [...this.#documents.keys()]
    if (names.length === 1) {
      return names[0]!
    }

    throw new ErrOpenAPIDocumentAmbiguous(names)
  }
}
