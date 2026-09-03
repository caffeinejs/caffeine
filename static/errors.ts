import { ErrCaffeineWebApplication } from '@caffeinejs/http'

/**
 * ErrDuplicateSPAMount is thrown at start-up when `spa()` is called more than once.
 *
 * A second shell has no meaning: the fallback serves one document for every client route, so the second call
 * either duplicates the first or silently loses to it.
 */
export class ErrDuplicateSPAMount extends ErrCaffeineWebApplication {
  constructor(roots: readonly string[]) {
    super(`Cannot configure more than one SPA mount: "${roots.join('", "')}"`, 'ERR_DUPLICATE_SPA_MOUNT')
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
