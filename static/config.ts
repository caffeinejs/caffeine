import type { Duration } from '@caffeinejs/std/duration'

import type { ManifestFile } from './manifest/manifest.js'

/** What `.serve(...)` accepts as a mount root: a directory, named or as a `file:` URL. */
export type StaticRoot = string | URL

/** How a mount serves its root. Every member is optional. */
export interface MountOptions {
  /** URL prefix the files register under, without the application's base path. Default `'/'`. */
  prefix?: string
  /**
   * Exempt every route of this mount from authentication, and mark its responses `public`. Default `false`.
   *
   * Without it the routes answer to the application's policy, which leaves them open unless the application
   * requires authentication by default, and every response is `private`, since that policy may be a cookie. A
   * single-page application's bundle wants it: the page that has not signed in yet still loads its scripts. No
   * principal is established for such a route.
   */
  anonymous?: boolean
  /**
   * `'manifest'` serves what `static.manifest.json` lists. `'scan'` reads the directory at start-up instead, with no
   * build step and no compressed variants, and is refused where `NODE_ENV` is `production` unless
   * `allowProduction()` is called. Default `'manifest'`.
   */
  mode?: 'manifest' | 'scan'
  /**
   * The file name that also answers at its directory's path: `docs/index.html` at `docs/`, and a root one at the
   * prefix. `false` for none. Default `'index.html'`.
   */
  index?: string | false
  /**
   * Globs of files registered as no route, still sent by `sendFile`, such as a single-page application's shell
   * `['index.html']`, or `['**']` for a bundle served only through `sendFile`. Default `[]`.
   */
  unrouted?: readonly string[]
  /**
   * `Cache-Control` of a file `immutable` does not match, after the `public` or `private` the mount derives. It may
   * not name either. Default `'no-cache'`, so every reuse is revalidated against the `ETag`.
   */
  cacheControl?: string
  /**
   * How long a file `immutable` matches is cached, written as `max-age` in whole seconds with `immutable`. At least
   * one second. Default `365 * Day`.
   */
  immutableMaxAge?: Duration
  /**
   * Globs of files whose names a bundler fingerprinted, such as `['assets/**']`, cached for `immutableMaxAge`. Never
   * a file whose name stays the same when its bytes change. Default `[]`.
   */
  immutable?: readonly string[]
  /**
   * Extra headers for a file, computed once per file at start-up, such as CORS on fonts or a CSP on a document.
   * `Vary` merges with the server's; `Cache-Control` and the headers the server computes are refused.
   */
  headers?: (file: ManifestFile, path: string) => Readonly<Record<string, string>> | undefined
}

/** One mount as a configuration tree carries it: the root and the data members of {@link MountOptions}. */
export interface StaticMountConfig extends Readonly<Omit<MountOptions, 'headers'>> {
  readonly root: string
}

/** What `StaticBuilder.config` accepts. */
export interface StaticOptions {
  mounts?: readonly StaticMountConfig[]
}

/** One mount the plugin serves: its root as given and resolved, and its options. */
export interface ResolvedMount {
  /** The root as `.serve(...)` resolved it, absolute. */
  readonly root: string
  readonly options: MountOptions
}

/** What the plugin serves, folded from the builder. */
export interface ResolvedStatic {
  readonly mounts: readonly ResolvedMount[]
  readonly allowProduction: boolean
}
