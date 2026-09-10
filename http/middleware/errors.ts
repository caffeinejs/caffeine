import { ErrCaffeineWebApplication } from '../error/common.js'

/**
 * ErrPipelineSealed is thrown when a middleware is registered after the application is ready.
 *
 * The pipeline is composed into the routes at start-up, so a later registration would silently never run.
 * Refusing it is the only way the caller finds out.
 */
export class ErrPipelineSealed extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot register a middleware: the application is already started, and the pipeline was composed at ' +
        'start-up',
      'ERR_PIPELINE_SEALED',
    )
    this.name = 'ErrPipelineSealed'
  }
}

/**
 * ErrNextCalledTwice is thrown when one middleware calls `next()` more than once.
 *
 * The second call would run the rest of the pipeline — and the handler — a second time, against a request
 * that is often already answered. Treated as the programming error it is rather than deduplicated, because
 * a middleware that does this has lost track of its own control flow.
 */
export class ErrNextCalledTwice extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot continue the pipeline: next() was called more than once by the same middleware',
      'ERR_NEXT_CALLED_TWICE',
    )
    this.name = 'ErrNextCalledTwice'
  }
}
