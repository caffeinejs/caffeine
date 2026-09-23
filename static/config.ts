import { resolve } from 'node:path'

import type { RouteAuthzOptions } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { FastifyStaticOptions } from '@fastify/static'

/**
 * The shape of a `static` block an application may declare in its configuration tree.
 *
 * The builder reads no configuration itself: what a fluent method sets is final. This type and
 * {@link staticConfigSchema} exist so an application that wants its mounts or its shell's root to come from
 * a file or the environment can declare the block, and hand the values over in its own callback:
 *
 * ```ts
 * .with(staticFiles((s, { config }) => s.spa(config.static.spas[0].root)))
 * ```
 *
 * `mounts` mirrors `.serve(...)` calls and `spas` the `.spa(...)` ones.
 */
export interface StaticConfig {
  mounts?: StaticMount[]
  spas?: Array<Partial<SPAOptions & { root: string }>>
}

/**
 * A single static mount — a full `@fastify/static` options object (`root` required, plus `prefix`, `index`,
 * `wildcard`, `maxAge`, etc.). The {@link StaticBuilder} assembles one per `.serve(...)` call and the
 * plugin registers each.
 */
export type StaticMount = FastifyStaticOptions

/** One shell the plugin serves: its resolved settings and the `@fastify/static` mount serving its files. */
export interface ResolvedSPA {
  settings: SPASettings
  mount: StaticMount
}

/** What the feature actually serves: the plain mounts and the shells, folded from the builder. */
export interface ResolvedStatic {
  mounts: StaticMount[]
  spas: ResolvedSPA[]
}

// SPA
// .

/**
 * Per-file cache policy for a SPA mount.
 *
 * `@fastify/static`'s `maxAge` is per **mount**, so one mount cannot say "the shell must be revalidated but
 * the hashed assets never expire" — which is exactly what a SPA needs. The assets get theirs through
 * `setHeaders`, which runs per file; the shell gets `shell` from the route that serves it.
 */
export interface SPACacheOptions {
  /**
   * Path prefixes whose files are content-hashed and therefore safe to cache forever
   * (`public, max-age=31536000, immutable`). Defaults to `['/assets']`, Vite's `build.assetsDir`.
   *
   * Prefix-based rather than sniffing a hash out of the file name: a name like `my-component.js` looks
   * hashed to any such pattern, and a false positive pins a mutable file in every visitor's browser for a
   * year with no way to recall it.
   */
  immutable?: readonly string[]
  /** `Cache-Control` for the shell document. Default `'no-cache'` — revalidate, so a deploy is picked up. */
  shell?: string
  /** `Cache-Control` for files that are neither the shell nor immutable. Default `'public, max-age=3600'`. */
  other?: string
}

/**
 * How a shell decides which requests it answers.
 *
 * The defaults are meant to be enough on their own: the prefixes the server owns are derived from the
 * compiled routing, so adding a controller does not require editing an exclude list here.
 */
export interface SPAOptions {
  /** The shell document, relative to the mount root. Default `'index.html'`. */
  index?: string
  /** Where the SPA is mounted. Must match the site's Vite `base`. Default `'/'`. */
  prefix?: string
  /**
   * Extra path prefixes that must never receive the shell, on top of the derived ones.
   *
   * Needed only for a path the router does not know about — a reverse-proxied upstream, say. A controller's
   * own prefix is already excluded.
   */
  exclude?: readonly string[]
  /**
   * Path prefixes that must receive the shell even though derivation marked them server-owned.
   *
   * The escape hatch for a client route that shares a prefix with a controller.
   */
  include?: readonly string[]
  /**
   * Derive the server-owned prefixes from the compiled routing. Default `true`.
   *
   * Turning this off means {@link exclude} is the only thing standing between an API miss and an HTML
   * document, and it will drift.
   */
  derive?: boolean
  /**
   * Answer only browser navigations with the shell. Default `true`.
   *
   * Decided by `isNavigation` from `@caffeinejs/http`, the same rule an authentication scheme redirects on:
   * Fetch Metadata when the request carries it (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`),
   * `Accept` naming `text/html` otherwise. So a mistyped `fetch('/typo')` stays a 404 rather than handing
   * JavaScript an HTML page it cannot parse, and so does a client whose `Accept` names no HTML, a bare wildcard
   * included, which is what curl and axios send. A request carrying neither header has not said, and is given
   * the shell.
   */
  navigationOnly?: boolean
  /** Per-file cache policy, or `false` to leave every header to `@fastify/static` and the shell's to the browser. */
  cache?: SPACacheOptions | false
  /**
   * What to do when the shell is missing at start-up. Default `'error'`.
   *
   * `'skip'` makes the shell inert, which is how one application serves its API without the site having been
   * built — a dev server or an API-only test run.
   */
  onMissingIndex?: 'error' | 'skip'
  /**
   * Who may load the shell, with the meaning `@Authorize` gives the same options. Default
   * `{ allowAnonymous: true }`: the shell is public and its assets are exempt from the application's fallback
   * policy, since a page nobody can load has no use for them.
   *
   * `{}` gates the shell behind the application's authentication, the way an undecorated `@Authorize()` does,
   * so a browser navigating to a client route unauthenticated is challenged, redirected to sign in by a
   * cookie or OpenID Connect scheme, before it ever sees the page. A policy or roles narrow it further, for an
   * administration site only some may open. Assets of a gated shell follow the application's fallback policy
   * like any file route.
   */
  authorize?: RouteAuthzOptions
  /**
   * Any remaining `@fastify/static` option for the shell's file mount. The options the shell needs a say in
   * are not accepted: the mount's `prefix`, `index`, `wildcard`, `redirect`, `decorateReply`, `setHeaders`
   * and `globIgnore` are the shell's to set.
   */
  static?: Omit<
    StaticMount,
    'root' | 'wildcard' | 'prefix' | 'index' | 'redirect' | 'decorateReply' | 'setHeaders' | 'globIgnore'
  >
}

/** The resolved settings a shell carries, with every default applied and the root made absolute. */
export interface SPASettings {
  root: string
  index: string
  prefix: string
  exclude: readonly string[]
  include: readonly string[]
  derive: boolean
  navigationOnly: boolean
  cache: Required<SPACacheOptions> | false
  onMissingIndex: 'error' | 'skip'
  authorize: RouteAuthzOptions
}

export const DEFAULT_SPA_CACHE: Required<SPACacheOptions> = {
  immutable: ['/assets'],
  shell: 'no-cache',
  other: 'public, max-age=3600',
}

/**
 * Applies the defaults, normalizing every prefix to a leading slash and no trailing slash, and the root to an
 * absolute path, which `@fastify/static` requires and the per-file cache policy compares against.
 */
export function resolveSPASettings(root: string, options: SPAOptions = {}): SPASettings {
  const immutable = (options.cache === false ? [] : (options.cache?.immutable ?? DEFAULT_SPA_CACHE.immutable)).map(
    normalizePrefix,
  )
  const cache = options.cache === false ? (false as const) : { ...DEFAULT_SPA_CACHE, ...options.cache, immutable }

  return {
    root: resolve(root),
    index: options.index ?? 'index.html',
    prefix: normalizePrefix(options.prefix ?? '/'),
    exclude: (options.exclude ?? []).map(normalizePrefix),
    include: (options.include ?? []).map(normalizePrefix),
    derive: options.derive ?? true,
    navigationOnly: options.navigationOnly ?? true,
    cache,
    onMissingIndex: options.onMissingIndex ?? 'error',
    authorize: options.authorize ?? { allowAnonymous: true },
  }
}

/** `'assets'` and `'/assets/'` both mean `/assets`; `'/'` stays `''` so it prefixes every path. */
export function normalizePrefix(prefix: string): string {
  const withLeading = prefix.startsWith('/') ? prefix : `/${prefix}`
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : ''
}

/** Whether `path` sits at or under `prefix`, by segment — so `/apifoo` is not under `/api`. */
export function underPrefix(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * A third-party option bag, carried through the tree untouched.
 *
 * It has to be a `Record` rather than a declared object: `Value.Clean` strips every property a schema does not
 * name — even under `additionalProperties: true` — so declaring a partial mirror of `@fastify/static`'s
 * options would silently drop the rest, and a callback option with it. A `Record` of unknowns is validated as
 * "an object" and handed on with every key intact.
 */
const optionBag = (): ReturnType<typeof $t.Record> => $t.Record($t.String(), $t.Unknown())

const spaCacheSchema = $t.Union([
  $t.Literal(false),
  $t.Object({
    immutable: $t.Optional($t.List($t.String())),
    shell: $t.Optional($t.String()),
    other: $t.Optional($t.String()),
  }),
])

/**
 * The schema of the `static` block in {@link StaticConfig}.
 *
 * The SPA options are ours, so they are declared and validated. The `@fastify/static` mount options and the
 * authorization options are not — they are numerous, they move between releases, and a hand-maintained mirror
 * would reject options that work. Nothing is defaulted here: {@link resolveSPASettings} already owns the SPA
 * defaults, and the block reaches the builder only through the application's own callback.
 */
export const staticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(optionBag())),
  spas: $t.Optional(
    $t.Array(
      $t.Object({
        root: $t.Optional($t.String()),
        index: $t.Optional($t.String()),
        prefix: $t.Optional($t.String()),
        exclude: $t.Optional($t.List($t.String())),
        include: $t.Optional($t.List($t.String())),
        derive: $t.Optional($t.Boolean()),
        navigationOnly: $t.Optional($t.Boolean()),
        onMissingIndex: $t.Optional($t.UnionEnum(['error', 'skip'])),
        cache: $t.Optional(spaCacheSchema),
        authorize: $t.Optional(optionBag()),
        static: $t.Optional(optionBag()),
      }),
    ),
  ),
})
