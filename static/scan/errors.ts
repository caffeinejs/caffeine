import { errMessage } from '@caffeinejs/std/err'

/**
 * ErrStaticBuild is thrown when a directory cannot be built into, or scanned for, static files: a file nothing types,
 * a name the router would read as syntax, or a root that cannot be read. `buildStatic()` throws it, and so does a
 * `mode: 'scan'` mount at start-up.
 *
 * It extends `Error` so `@caffeinejs/static/build` loads nothing of the server.
 */
export class ErrStaticBuild extends Error {
  readonly code = 'ERR_STATIC_BUILD'

  constructor(root: string, detail: string, ...solutions: string[]) {
    super(
      errMessage(`Cannot build static files from "${root}": ${detail}`)
        .solutions(...solutions)
        .reference('@caffeinejs/static', ErrStaticBuild)
        .build(),
    )
    this.name = 'ErrStaticBuild'
  }
}
