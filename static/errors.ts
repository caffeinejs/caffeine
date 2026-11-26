import { ErrCaffeineWebApplication } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'

/**
 * ErrStaticScanInProduction is thrown at start-up by a `mode: 'scan'` mount where `NODE_ENV` is `production` and
 * `allowProduction()` was not called.
 */
export class ErrStaticScanInProduction extends ErrCaffeineWebApplication {
  constructor(root: string) {
    super(
      errMessage(`Cannot serve "${root}" in scan mode in production`)
        .solutions(
          "Run buildStatic({ root }) from @caffeinejs/static/build in the build and remove mode: 'scan'",
          'Call allowProduction() on the builder',
        )
        .reference('@caffeinejs/static', ErrStaticScanInProduction)
        .build(),
      'ERR_STATIC_SCAN_IN_PRODUCTION',
    )
    this.name = 'ErrStaticScanInProduction'
  }
}

/**
 * ErrStaticRouteConflict is thrown at start-up when two files of one `staticFiles(...)` registration answer one URL:
 * two mounts listing one path, an index directory equal to another file's URL, or a nested mount whose directory
 * route takes in another's files. Without `second`, another route of the registration answers the file's URL, as the
 * router matches it.
 */
export class ErrStaticRouteConflict extends ErrCaffeineWebApplication {
  constructor(url: string, first: string, second?: string) {
    const message =
      second === undefined
        ? errMessage(`Cannot register "${url}": "${first}" answers another route at that URL`).solutions(
            'Move the other route to a path no file has',
            'Serve the directory under its own prefix',
            'Add the file to unrouted on its mount',
          )
        : errMessage(`Cannot register "${url}": "${first}" and "${second}" both answer it`).solutions(
            'Serve one of the directories under its own prefix',
            'Add one of the files to unrouted on its mount',
          )

    super(message.reference('@caffeinejs/static', ErrStaticRouteConflict).build(), 'ERR_STATIC_ROUTE_CONFLICT')
    this.name = 'ErrStaticRouteConflict'
  }
}

/**
 * ErrSendFileUnavailable is thrown when `sendFile` is called on a server with no `staticFiles(...)` installed, on
 * one whose `staticFiles(...)` serves no root, with a root no mount serves, or on a request no route matched.
 */
export class ErrSendFileUnavailable extends ErrCaffeineWebApplication {
  /**
   * @param installed - Whether `staticFiles(...)` is installed; read only without a `root`
   * @param matched - Whether the request matched a route; read only without a `root`
   */
  constructor(root?: string, installed = false, matched = true) {
    const message =
      root !== undefined
        ? errMessage(`Cannot send a file from "${root}": no mount serves it`).solutions(
            'Pass a root a .serve(...) call serves',
            `Add .serve("${root}") to staticFiles(...)`,
          )
        : !matched
          ? errMessage('Cannot send a file: the request matched no route, so no mount can be found').solutions(
              'Answer the request from a route, such as a "/*" route that calls sendFile',
            )
          : installed
            ? errMessage('Cannot send a file: staticFiles(...) serves no root').solutions(
                'Add .serve(root) to staticFiles(...)',
              )
            : errMessage('Cannot send a file: staticFiles(...) is not installed').solutions(
                'Install staticFiles(s => s.serve(root)) on the server that serves this route',
              )

    super(message.reference('@caffeinejs/static', ErrSendFileUnavailable).build(), 'ERR_SEND_FILE_UNAVAILABLE')
    this.name = 'ErrSendFileUnavailable'
  }
}
