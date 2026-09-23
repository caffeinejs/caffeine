import { ErrCaffeineWebApplication } from '@caffeinejs/http'

/**
 * ErrDuplicateSPAMount is thrown at start-up when `spa()` is called twice for the same prefix.
 *
 * Two shells at one prefix have no meaning: the route serving that prefix answers with one document, so the
 * second call either duplicates the first or silently loses to it. Shells at different prefixes are fine.
 */
export class ErrDuplicateSPAMount extends ErrCaffeineWebApplication {
  constructor(prefix: string) {
    super(`Cannot configure two SPA mounts at the same prefix "${prefix}"`, 'ERR_DUPLICATE_SPA_MOUNT')
    this.name = 'ErrDuplicateSPAMount'
  }
}

/**
 * ErrSPAIndexMissing is thrown at start-up when the shell document is not on disk.
 *
 * Almost always a build that did not run, and the alternative is an application that starts and answers every
 * client route with a 404 nobody can explain.
 */
export class ErrSPAIndexMissing extends ErrCaffeineWebApplication {
  constructor(indexPath: string) {
    super(
      `Cannot serve the SPA: the shell document does not exist: "${indexPath}"` +
        '\nPossible Solutions:' +
        '\n  - Build the site so the shell and its assets exist before the server starts' +
        '\n  - Point spa() at the directory holding index.html' +
        '\n  - Pass { onMissingIndex: "skip" } to start without the site, serving the API alone',
      'ERR_SPA_INDEX_MISSING',
    )
    this.name = 'ErrSPAIndexMissing'
  }
}
