import type { OpenAPIDocument } from './spec/spec.js'

/** Everything the document endpoints serve, computed once when the server phase fills the store. */
export interface OpenAPIPayload {
  document: OpenAPIDocument
  json: string
  yaml: string
  /** The documentation page, absent when no UI is served. */
  docsPage?: string
  /** The UI's browser bundle, absent when no UI is served. */
  asset?: string
}

/**
 * Holds what the document endpoints serve.
 *
 * A mutable holder exists because of an ordering constraint: the endpoints are registered during
 * `[kServiceConfigure]`, before routing is built, while the document can only be generated afterwards — it
 * describes those very routes. The controller is constructed with an empty store and the server phase fills
 * it, so nothing has to resolve lazily or re-enter the container.
 *
 * Every representation is computed at fill time rather than per request. The document is immutable for the
 * process's lifetime, so re-serializing it on each call would be pure waste on routes a docs page hits on
 * every load.
 */
export class OpenAPIDocumentStore {
  #payload: OpenAPIPayload | undefined

  fill(payload: OpenAPIPayload): void {
    this.#payload = payload
  }

  get filled(): boolean {
    return this.#payload !== undefined
  }

  get document(): OpenAPIDocument {
    return this.#require().document
  }

  get json(): string {
    return this.#require().json
  }

  get yaml(): string {
    return this.#require().yaml
  }

  get docsPage(): string {
    return this.#requirePart(this.#require().docsPage, 'documentation page')
  }

  get asset(): string {
    return this.#requirePart(this.#require().asset, 'documentation asset')
  }

  #require(): OpenAPIPayload {
    if (this.#payload === undefined) {
      // Only reachable if a request beat the server phase, which the lifecycle does not allow — so this is a
      // guard against a future reordering, not a case anyone can hit today.
      throw new Error('Cannot serve the OpenAPI document: it has not been generated yet')
    }

    return this.#payload
  }

  #requirePart(value: string | undefined, what: string): string {
    if (value === undefined) {
      throw new Error(`Cannot serve the OpenAPI ${what}: no documentation UI is configured`)
    }

    return value
  }
}
