import { $t } from '@caffeinejs/std'
import { FastifyStaticOptions } from '@fastify/static'

/**
 * What an application may configure for static serving.
 *
 * `mounts` mirrors the `.serve(...)` calls and `spa` the `.spa(...)` one. A configured `spa.root` repoints
 * the directory `.spa(...)` switched on; other SPA keys still follow fluent-wins.
 *
 * **`mounts` replaces the list rather than patching it** — the array rule the merge engine applies everywhere.
 * `.serve()` is additive in code, but `STATIC__MOUNTS__0__ROOT` is not: it declares the entire list. That is
 * what makes it possible to *remove* a mount from a config file at all.
 */
export interface StaticConfig {
  mounts?: StaticMount[]
  spa?: Partial<SPAOptions & { root: string }>
}

/**
 * A single static mount — a full `@fastify/static` options object (`root` required, plus `prefix`, `index`,
 * `wildcard`, `maxAge`, etc.). The {@link StaticBuilder} assembles one per `.serve(...)` call and the
 * the plugin registers each.
 */
export type StaticMount = FastifyStaticOptions

/** What the feature actually serves, folded from the configured mounts and the SPA settings. */
export interface ResolvedStatic {
  mounts: StaticMount[]
  spa: SPASettings | undefined
}

// SPA
// .

/**
 * Per-file cache policy for a SPA mount.
 *
 * `@fastify/static`'s `maxAge` is per **mount**, so one mount cannot say "the shell must be revalidated but
 * the hashed assets never expire" — which is exactly what a SPA needs. These are applied through `setHeaders`
 * instead, which runs per file.
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
 * How the SPA mount decides which requests get the shell.
 *
 * The defaults are meant to be enough on their own: the prefixes the server owns are derived from the
 * resolved routing, so adding a controller does not require editing an exclude list here.
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
   * Derive the server-owned prefixes from the resolved routing. Default `true`.
   *
   * Turning this off means {@link exclude} is the only thing standing between an API miss and an HTML
   * document, and it will drift.
   */
  derive?: boolean
  /**
   * Answer only genuine document navigations with the shell. Default `true`.
   *
   * A browser sends `Sec-Fetch-Dest: document` when navigating and `empty` from `fetch()`, so this keeps a
   * mistyped `fetch('/typo')` a 404 rather than handing JavaScript an HTML page it cannot parse. Clients
   * that send neither `Sec-Fetch-Dest` nor `Accept` are allowed through.
   */
  navigationOnly?: boolean
  /** Per-file cache policy, or `false` to leave every header to `@fastify/static`. */
  cache?: SPACacheOptions | false
  /**
   * What to do when the shell is missing at start-up. Default `'error'`.
   *
   * `'skip'` makes the mount inert, which is how one application serves its API without the site having been
   * built — a dev server or an API-only test run.
   */
  onMissingIndex?: 'error' | 'skip'
  /** Any remaining `@fastify/static` option for this mount. */
  static?: Omit<StaticMount, 'root' | 'wildcard'>
}

/** The resolved SPA settings a mount carries, with every default applied. */
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
}

export const DEFAULT_SPA_CACHE: Required<SPACacheOptions> = {
  immutable: ['/assets'],
  shell: 'no-cache',
  other: 'public, max-age=3600',
}

/** Applies the defaults, normalizing every prefix to a leading slash and no trailing slash. */
export function resolveSPASettings(root: string, options: SPAOptions = {}): SPASettings {
  const immutable = (options.cache === false ? [] : (options.cache?.immutable ?? DEFAULT_SPA_CACHE.immutable)).map(
    normalizePrefix,
  )
  const cache = options.cache === false ? (false as const) : { ...DEFAULT_SPA_CACHE, ...options.cache, immutable }

  return {
    root,
    index: options.index ?? 'index.html',
    prefix: normalizePrefix(options.prefix ?? '/'),
    exclude: (options.exclude ?? []).map(normalizePrefix),
    include: (options.include ?? []).map(normalizePrefix),
    derive: options.derive ?? true,
    navigationOnly: options.navigationOnly ?? true,
    cache,
    onMissingIndex: options.onMissingIndex ?? 'error',
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
 * The schema governing the static slice.
 *
 * The SPA options are ours, so they are declared and validated. The `@fastify/static` mount options are not —
 * they are numerous, they move between releases, and a hand-maintained mirror would reject options that work.
 * Nothing is defaulted here: {@link resolveSPASettings} already owns the SPA defaults.
 */
export const staticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(optionBag())),
  spa: $t.Optional(
    $t.Object({
      // Optional: `.spa(root)` is the activating act and supplies the root. Configuration retunes a SPA the
      // application switched on; it never creates one, so a block without a root is not an error.
      root: $t.Optional($t.String()),
      index: $t.Optional($t.String()),
      prefix: $t.Optional($t.String()),
      exclude: $t.Optional($t.List($t.String())),
      include: $t.Optional($t.List($t.String())),
      derive: $t.Optional($t.Boolean()),
      navigationOnly: $t.Optional($t.Boolean()),
      onMissingIndex: $t.Optional($t.UnionEnum(['error', 'skip'])),
      cache: $t.Optional(spaCacheSchema),
      static: $t.Optional(optionBag()),
    }),
  ),
})
