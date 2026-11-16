import { validateHeaderName, validateHeaderValue } from 'node:http'
import { join, posix, relative } from 'node:path'

import {
  accessControlExempt,
  ErrConfiguration,
  ErrHTTPNotFound,
  ErrRouteConflict,
  findMyWayMatcher,
  HTTPPlugin,
  kRouteConstraints,
  Router,
  type AdapterExtensionFactory,
  type HTTPPluginConfigurer,
  type HTTPSetupContext,
  type IContext,
  type RouteDefinition,
  type RouteMatcher,
  type RouterFlags,
} from '@caffeinejs/http'
import { Day, Second, formatDuration, truncate } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { StaticBuilder, kBuild } from './builder.js'
import type { MountOptions, ResolvedMount } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { nameProblem, readManifest, type ManifestFile, type StaticManifest } from './manifest/manifest.js'
import { readFileEntry, scan } from './scan/scan.js'
import {
  FileResponder,
  prepareFile,
  rootOnDisk,
  verifyHashes,
  type FileLog,
  type FilePolicy,
  type PreparedFile,
} from './serve.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/** One mount as `sendFile` finds it: its root as `.serve(...)` resolved it, and every file it lists. */
export interface ServedMount {
  readonly root: string
  readonly files: ReadonlyMap<string, PreparedFile>
}

/** What `sendFile` reads for a route: its server's mounts, and where a failed open is logged. */
export interface ServedMounts {
  readonly mounts: readonly ServedMount[]
  readonly log: FileLog
}

/** The mounts of the server each route is served by, keyed as `onRoute` saw the route. */
export const mountsByRoute = new WeakMap<RouteDefinition, ServedMounts>()

/** Where the plugin logs: a failed open, and one line per mount at start-up. */
type StaticLog = FileLog & { info(fields: object, message: string): void }

// Marks the plugin's own routes, so its checks pass over them.
const kStaticRoute = 'caffeine:static-route'
const STATIC_ROUTE: unique symbol = Symbol('caffeine.static.route')
// What the private matcher holds for a route that is not the plugin's.
const OTHER: unique symbol = Symbol('caffeine.static.other-route')

/** A mount read and checked at start-up, ready to register. */
interface PreparedMount extends ServedMount {
  readonly prefix: string
  readonly anonymous: boolean
  readonly index: string | false
  readonly mode: 'manifest' | 'scan'
  /** The files registered as routes: every file `unrouted` does not match. */
  readonly routed: readonly PreparedFile[]
}

// What the server computes for every file; `headers(file)` may not set them.
const COMPUTED = new Set([
  'cache-control',
  'content-type',
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'x-content-type-options',
])

/**
 * Serves static files from a manifest, as a plugin: `.with(staticFiles(s => s.serve(root)))`.
 *
 * Each mount reads `static.manifest.json`, which `buildStatic()` from `@caffeinejs/static/build` writes, and serves
 * the files it lists and nothing else, every header computed at start-up: a request reads no file system metadata.
 * A file at the mount's root is a route of its own, and each directory under it is one route answering from the
 * files it lists, so a miss under a directory is a `404` and a miss elsewhere falls through to the application's
 * routes. Compressed variants are negotiated by `Accept-Encoding` and are never URLs of their own.
 *
 * Start-up fails loudly: a missing or stale manifest, a listed file that is not there, two files answering one URL,
 * and another route answering a file's URL each name the file and the fix. The collision check probes that URL
 * without request constraints. A version, host or custom constraint can select a different route for a request.
 * On a case-insensitive router, a case-sensitive parameter regex can select a different route for another spelling
 * of the URL. Install it once per server, on the application or a listener; a router, a controller and a server with a
 * matcher of its own are refused. One `staticFiles(...)` takes several `.serve(...)` calls.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): AdapterExtensionFactory<HTTPPlugin, C> {
  return async context => {
    const builder = new StaticBuilder()
    configure?.(builder, context)
    const { mounts, allowProduction } = builder[kBuild]()
    const prepared = await Promise.all(mounts.map(mount => prepareMount(mount, allowProduction)))

    for (const mount of prepared) {
      if (mount.mode === 'scan') {
        context.logger.warn(
          { root: mount.root },
          allowProduction && isProduction()
            ? 'Static files are served in scan mode in production'
            : 'Static files are served in scan mode: a snapshot taken at start-up, without compressed variants',
        )
      }
    }

    return new StaticFiles(prepared, context.logger)
  }
}

async function prepareMount({ root, options }: ResolvedMount, allowProduction: boolean): Promise<PreparedMount> {
  const mode = options.mode ?? 'manifest'

  if (mode === 'scan' && isProduction() && !allowProduction) {
    throw new ErrStaticScanInProduction(root)
  }

  const policy = policyOf(root, options)
  const prefix = prefixOf(root, options.prefix)
  const manifest = mode === 'scan' ? await scanned(root) : await readManifest(root)
  const disk = rootOnDisk(root)
  const files = new Map<string, PreparedFile>()
  const prepared = Object.entries(manifest.files).map(([path, entry]) => prepareFile(disk, path, entry, policy))

  for (const file of prepared) {
    files.set(file.path, file)
  }

  // A scan has just hashed the files itself. One file at a time, as the build reads them.
  if (mode === 'manifest') {
    for (const file of prepared) {
      await verifyHashes(root, file, manifest.files[file.path]!)
    }
  }

  const unrouted = options.unrouted ?? []

  return {
    root,
    files,
    prefix,
    anonymous: options.anonymous === true,
    index: options.index ?? 'index.html',
    mode,
    routed: unrouted.includes('**')
      ? []
      : prepared.filter(file => !unrouted.some(glob => posix.matchesGlob(file.path, glob))),
  }
}

/** The manifest a scan of `root` makes, every file hashed and none with variants. */
async function scanned(root: string): Promise<StaticManifest> {
  const { files } = await scan(root)
  // Keyed by the site's paths, "__proto__" among them.
  const entries: Record<string, ManifestFile> = Object.create(null)

  // One file at a time, as the build reads them: a tree of thousands would otherwise open them all at once.
  for (const file of files) {
    entries[file.path] = await readFileEntry(root, file.path, file.type)
  }

  return { version: 1, files: entries }
}

/**
 * Decides `Cache-Control` and the extra headers per file, refusing an option that would override what the mount
 * derives.
 */
function policyOf(root: string, options: MountOptions): FilePolicy {
  const cacheControl = options.cacheControl ?? 'no-cache'
  assertHeader(root, 'cacheControl', 'cache-control', cacheControl)

  // Only unquoted commas separate directives. Leave the quoted values as the caller wrote them.
  const directives = cacheControl
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .split(',')
    .map(directive => directive.trim())
    .filter(Boolean)
  const scope = directives.find(directive => /^(?:public|private)$/i.test(directive.split('=', 1)[0]!.trim()))

  if (scope !== undefined) {
    throw new ErrConfiguration(
      errMessage(`Cannot serve "${root}": cacheControl names "${scope}", which the mount derives from anonymous`)
        .solutions(`Remove "${scope}" from cacheControl`, 'Set anonymous: true on the mount for public responses')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  const maxAge = truncate(options.immutableMaxAge ?? 365 * Day, Second)

  if (maxAge < Second) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot serve "${root}": immutableMaxAge is ${formatDuration(options.immutableMaxAge!)}, under the one second Cache-Control can carry`,
      )
        .solutions('Set immutableMaxAge to at least 1 * Second, such as 365 * Day')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  const immutable = options.immutable ?? []
  const directive = (path: string) =>
    immutable.some(glob => posix.matchesGlob(path, glob))
      ? `max-age=${Math.floor(maxAge / Second)}, immutable`
      : cacheControl.trim()
  const scoped = (scopeName: string, path: string) => [scopeName, directive(path)].filter(Boolean).join(', ')
  const routeScope = options.anonymous === true ? 'public' : 'private'

  return {
    routeCacheControl: path => scoped(routeScope, path),
    sendFileCacheControl: path => scoped('private', path),
    headers: (path, file) => extraHeaders(root, path, file, options.headers),
  }
}

function extraHeaders(
  root: string,
  path: string,
  file: ManifestFile,
  headers: MountOptions['headers'],
): Readonly<Record<string, string>> | undefined {
  const given = headers?.(file, path)

  if (given === undefined) {
    return undefined
  }

  const lowered: Record<string, string> = {}

  for (const [name, value] of Object.entries(given)) {
    const key = name.toLowerCase()

    // A Fastify reply keeps its headers in a plain object, where that name sets the prototype: it would never be sent.
    if (key === '__proto__') {
      throw new ErrConfiguration(
        errMessage(
          `Cannot serve "${root}": headers(file) returned "__proto__" for "${path}", which a reply cannot send`,
        )
          .solutions('Remove "__proto__" from what headers(file) returns')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    if (COMPUTED.has(key)) {
      throw new ErrConfiguration(
        errMessage(`Cannot serve "${root}": headers(file) returned "${key}" for "${path}", which the server computes`)
          .solutions(
            key === 'cache-control'
              ? 'Set cacheControl, immutable or immutableMaxAge on the mount instead'
              : `Remove "${key}" from what headers(file) returns`,
          )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    assertHeader(root, `headers(file) for "${path}"`, name, value)
    lowered[key] = value
  }

  return lowered
}

function assertHeader(root: string, option: string, name: string, value: string): void {
  try {
    validateHeaderName(name)
    validateHeaderValue(name, value)
  } catch {
    throw new ErrConfiguration(
      errMessage(`Cannot serve "${root}": ${option} sets an invalid HTTP header ${JSON.stringify(name)}`)
        .solutions(`Supply a valid header name and value in ${option}`)
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }
}

/**
 * `'/'`, or the prefix with one leading and one trailing slash, refused by the rules a file's name answers to: every
 * URL the mount registers starts with it.
 */
function prefixOf(root: string, prefix: string | undefined): string {
  const trimmed = (prefix ?? '/').replace(/^\/+|\/+$/g, '')
  const normalized = trimmed === '' ? '/' : `/${trimmed}/`
  const problem = nameProblem(normalized)

  if (problem !== undefined) {
    throw new ErrConfiguration(
      errMessage(`Cannot serve "${root}": the prefix ${problem}`)
        .solutions('Write the prefix without that character, in Unicode NFC, such as "/assets"')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return normalized
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/** A URL the plugin registers, and what answers it. */
type RouteTarget =
  | { readonly kind: 'file'; readonly file: PreparedFile; readonly mount: PreparedMount }
  | {
      readonly kind: 'directory'
      readonly files: Map<string, PreparedFile>
      readonly mount: PreparedMount
      readonly first: PreparedFile
    }
  | { readonly kind: 'root-index'; readonly file: PreparedFile; readonly mount: PreparedMount }

/** A URL the plugin claims, and the file that answers it. */
interface Claim {
  readonly url: string
  readonly mount: PreparedMount
  readonly file: PreparedFile
}

/** The router as the plugin models it, to ask which route answers a URL. */
type StaticMatcher = RouteMatcher<RouteTarget | typeof OTHER>

class StaticFiles extends HTTPPlugin {
  override readonly name = '@caffeinejs/static'
  readonly #mounts: readonly PreparedMount[]
  readonly #log: StaticLog

  constructor(mounts: readonly PreparedMount[], log: StaticLog) {
    super()
    this.#mounts = mounts
    this.#log = log
  }

  register(context: HTTPSetupContext): void {
    const mounts = this.#mounts
    const log = this.#log
    const server = context.app.server

    if (server === undefined) {
      throw new ErrConfiguration(
        errMessage(
          "Cannot install staticFiles() on a router or a controller: it serves files at the server's own paths",
        )
          .solutions('Register it on the application or a listener: ".with(staticFiles(...))"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    const router = server.router

    if (router === undefined) {
      throw new ErrConfiguration(
        errMessage(
          'Cannot install staticFiles(): the server matches routes with a matcher of its own, and static routes are matched by find-my-way',
        )
          .solutions('Leave the matcher setting out of ".server(...)" on the server that serves static files')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    if (!router.ignoreDuplicateSlashes) {
      assertNoEmptySegment(mounts)
    }

    const { routes, taken } = routesOf(mounts, router)

    if (router.useSemicolonDelimiter) {
      assertNoSemicolon(mounts)
    }

    const served: ServedMounts = { mounts: mounts.map(({ root, files }) => ({ root, files })), log }
    const others: Array<{ readonly methods: readonly string[]; readonly url: string }> = []

    // Runs before the server adds the route, so a route at a URL the plugin answers is refused naming the file. A
    // constrained route is left alone: what it matches depends on the request.
    context.app.hook('onRoute', route => {
      mountsByRoute.set(route, served)

      if (route.config.get(kStaticRoute) === STATIC_ROUTE || route.config.get(kRouteConstraints) !== undefined) {
        return
      }

      // A prefixed root also answers its URL with a slash, which a nested index claims.
      const prefix = route.group.prefix
      const paths =
        !router.ignoreTrailingSlash &&
        prefix !== undefined &&
        prefix !== '' &&
        prefix !== '/' &&
        route.url === prefix.replace(/\/$/, '')
          ? [route.url, `${route.url}/`]
          : [route.url]
      const reads = route.methods.includes('GET') || route.methods.includes('HEAD')

      for (const url of paths) {
        others.push({ methods: route.methods, url })

        const held = reads ? taken.get(pathKey(url, router)) : undefined
        if (held !== undefined) {
          throw new ErrStaticRouteConflict(held.url, describe(held.mount, held.file))
        }
      }
    })

    // Once every route is in, the router's own rules say what answers each file under a directory: an exact, parametric
    // or longer wildcard route registered before or after the mount, in any spelling it folds, ranks above the
    // directory's wildcard and would answer the file under its own gate. Asked of a find-my-way built with the
    // server's flags, which is how the server matches.
    context.app.hook('onReady', () => {
      const matcher: StaticMatcher = findMyWayMatcher<RouteTarget | typeof OTHER>(router, [])
      const hold = (method: string, url: string, store: RouteTarget | typeof OTHER) => {
        try {
          matcher.add(method, url, undefined, store)
        } catch (err) {
          // A path already held answers the same: a second spelling, or a route beside a constrained one.
          if (!(err instanceof ErrRouteConflict)) {
            throw err
          }
        }
      }

      for (const { methods, url } of others) {
        for (const method of methods) {
          hold(method, url, OTHER)
        }
        if (methods.includes('GET') && !methods.includes('HEAD')) {
          hold('HEAD', url, OTHER)
        }
      }

      for (const [url, target] of routes) {
        for (const method of ['GET', 'HEAD']) {
          if (target.kind === 'root-index') {
            hold(method, url.slice(0, -1), target)
            if (!router.ignoreTrailingSlash) {
              hold(method, url, target)
            }
          } else {
            hold(method, url, target)
          }
        }
      }

      for (const mount of mounts) {
        for (const file of mount.routed) {
          const url = mount.prefix + file.path

          if (!routes.has(url) && !answeredByMount(matcher, url, file.path.slice(file.path.indexOf('/') + 1), router)) {
            const nested = nestedDirectory(matcher, url, mount, routes, router)

            throw nested === undefined
              ? new ErrStaticRouteConflict(url, describe(mount, file))
              : new ErrStaticRouteConflict(url, describe(mount, file), describe(nested.mount, firstOf(nested)))
          }
        }
      }

      // The checks are done: what they kept goes, so the hooks hold nothing for the server's lifetime.
      taken.clear()
      others.length = 0
    })

    const open = staticRouter().extend(accessControlExempt())
    const guarded = staticRouter()
    const mounted = new Set<Router>()
    let n = 0

    for (const [url, target] of routes) {
      if (target.kind === 'root-index') {
        // A route path loses its trailing slash; the group prefix is served with and without it.
        const root = staticRouter().extend((group: { prefix(prefix: string): unknown }) => {
          group.prefix(target.mount.prefix.slice(0, -1))
        })
        ;(target.mount.anonymous ? root.extend(accessControlExempt()) : root)
          .get('/')
          .name('static_index')
          .handler(fileHandler(target.file, log))
        mounted.add(root)
        continue
      }

      const into = target.mount.anonymous ? open : guarded
      mounted.add(into)
      into
        .get(url)
        .name(`static_${n++}`)
        .handler(target.kind === 'file' ? fileHandler(target.file, log) : directoryHandler(target.files, router, log))
    }

    context.app.mount(...mounted)

    for (const mount of mounts) {
      log.info(
        {
          root: mount.root,
          prefix: mount.prefix,
          mode: mount.mode,
          files: mount.files.size,
          routed: mount.routed.length,
          variants: [...mount.files.values()].reduce((sum, file) => sum + file.variants.length, 0),
        },
        'Serving static files',
      )
    }
  }
}

/** A router for the plugin's routes: kept out of a generated document, and marked as the plugin's. */
function staticRouter(): Router {
  return new Router().detail('http', { internal: true }).config(kStaticRoute, STATIC_ROUTE)
}

/** The parameters of the route `matcher` hands `url` to, or `undefined` for none or a spelling it cannot decode. */
function paramsOf(matcher: StaticMatcher, method: string, url: string): Record<string, string | undefined> | undefined {
  try {
    return matcher.match(method, url, undefined)?.params
  } catch {
    return undefined
  }
}

/** Refuses a prefix with an empty segment, which a route path collapses where the router does not. */
function assertNoEmptySegment(mounts: readonly PreparedMount[]): void {
  for (const mount of mounts) {
    if (mount.prefix.includes('//')) {
      throw new ErrConfiguration(
        errMessage(
          `Cannot serve "${mount.root}": the prefix "${mount.prefix}" holds an empty segment, which a route path cannot keep`,
        )
          .solutions('Write the prefix without "//"', 'Set router: { ignoreDuplicateSlashes: true } in ".server(...)"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }
}

/** The path of a request target, with the authority and query removed as the router removes them. */
function pathOf(url: string, router: RouterFlags): string {
  // An absolute-form target reaches a directory route only with a path after its authority.
  const path = url.startsWith('/') ? url : url.slice(url.indexOf('/', url.indexOf('://') + 3))
  const end = path.search(router.useSemicolonDelimiter ? /[?#;]/ : /[?#]/)

  return end === -1 ? path : path.slice(0, end)
}

/** A path key with the router's slash and case options applied. */
function pathKey(path: string, router: RouterFlags): string {
  const slashes = router.ignoreDuplicateSlashes ? path.replace(/\/{2,}/g, '/') : path
  const normalized = router.ignoreTrailingSlash && slashes.length > 1 ? slashes.replace(/\/$/, '') : slashes

  return key(normalized, router)
}

/**
 * Refuses a routed file with `;` in its name where the router reads `;` as the start of the query: its URL ends
 * before the `;`, and `%3B` is no name under a directory, so nothing would reach it.
 */
function assertNoSemicolon(mounts: readonly PreparedMount[]): void {
  for (const mount of mounts) {
    // Every URL the mount registers starts with its prefix.
    if (mount.prefix.includes(';') && mount.routed.length > 0) {
      throw new ErrConfiguration(
        errMessage(
          `Cannot serve "${mount.root}": the prefix "${mount.prefix}" holds ";", which useSemicolonDelimiter reads as the start of the query`,
        )
          .solutions('Write the prefix without ";"', 'Turn useSemicolonDelimiter off')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    const file = mount.routed.find(({ path }) => path.includes(';'))

    if (file !== undefined) {
      throw new ErrConfiguration(
        errMessage(
          `Cannot serve "${mount.root}": "${file.path}" holds ";", which useSemicolonDelimiter reads as the start of the query`,
        )
          .solutions(
            `Rename "${file.path}" without ";"`,
            `Add "${file.path}" to unrouted on its mount and send it with sendFile`,
            'Turn useSemicolonDelimiter off',
          )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }
}

/**
 * The directory route of another mount that the router hands `url` to, if one does: only to name its file in the
 * error, since the router has already said the URL is not the mount's.
 */
function nestedDirectory(
  matcher: StaticMatcher,
  url: string,
  mount: PreparedMount,
  routes: ReadonlyMap<string, RouteTarget>,
  router: RouterFlags,
): RouteTarget | undefined {
  const params = paramsOf(matcher, 'GET', encodeURI(url))
  const star = params?.['*']

  if (star === undefined || !key(url, router).endsWith(key(star, router))) {
    return undefined
  }

  const base = (path: string) => key(router.ignoreDuplicateSlashes ? path.replace(/\/{2,}/g, '/') : path, router)
  const taken = base(url.slice(0, url.length - star.length))

  for (const [other, target] of routes) {
    if (target.kind === 'directory' && target.mount !== mount && base(other.slice(0, -1)) === taken) {
      return target
    }
  }

  return undefined
}

/**
 * Whether the router hands a GET and a HEAD at `url` to the directory route that serves `rest`, the file's path under
 * its directory, rather than to another route.
 */
function answeredByMount(matcher: StaticMatcher, url: string, rest: string, router: RouterFlags): boolean {
  const prefix = url.slice(0, url.length - rest.length)
  const folded = key(prefix, router)
  const extra = folded.length - prefix.length
  // The router uses the folded prefix's length to slice the original path, before decoding any escaped percent.
  const captured = extra === 0 ? rest : rest.replaceAll('%', '%25').slice(extra).replaceAll('%25', '%')

  const answers = (path: string, expected: string) => {
    // Spelled as a browser sends it, which the router decodes as it does a request's.
    const sent = encodeURI(path)

    return ['GET', 'HEAD'].every(method => {
      const params = paramsOf(matcher, method, sent)

      return (
        params !== undefined &&
        Object.keys(params).length === 1 &&
        params['*'] !== undefined &&
        key(params['*'], router) === key(expected, router)
      )
    })
  }

  // An expanded prefix can leave an empty capture even for a longer wildcard. Check the folded spelling too.
  return answers(url, captured) && (extra === 0 || answers(folded + rest, rest))
}

/**
 * The routes every mount registers, checked for two files answering one URL as the router would match it: a file at
 * a mount's root and an index at a mount's root have their own route, and each directory under the root one route
 * answering from its files, index URLs included.
 */
function routesOf(
  mounts: readonly PreparedMount[],
  router: RouterFlags,
): { routes: Map<string, RouteTarget>; taken: Map<string, Claim> } {
  const claimed = new Map<string, Claim>()
  // Each directory route's URL as first spelled, by its URL as the router matches it.
  const directories = new Map<string, string>()
  const claim = (url: string, mount: PreparedMount, file: PreparedFile) => {
    const normalized = pathKey(url, router)
    const held = claimed.get(normalized)

    if (held !== undefined) {
      throw new ErrStaticRouteConflict(url, describe(held.mount, held.file), describe(mount, file))
    }

    claimed.set(normalized, { url, mount, file })
  }
  const routes = new Map<string, RouteTarget>()

  for (const mount of mounts) {
    for (const file of mount.routed) {
      claim(mount.prefix + file.path, mount, file)

      const slash = file.path.indexOf('/')
      const index = mount.index !== false && posix.basename(file.path) === mount.index

      if (slash === -1) {
        routes.set(mount.prefix + file.path, { kind: 'file', file, mount })
      } else {
        directoryRoute(routes, directories, mount, file, slash, index, router)
      }

      if (index) {
        const urls = indexURLs(mount, file, router)

        for (const url of urls) {
          claim(url, mount, file)
        }

        const directory = urls[0]!

        if (directory === mount.prefix) {
          routes.set(
            directory,
            mount.prefix === '/' ? { kind: 'file', file, mount } : { kind: 'root-index', file, mount },
          )
        } else if (router.ignoreTrailingSlash && directory.split('/').length === mount.prefix.split('/').length + 1) {
          // find-my-way trims the slash before matching, which the directory's wildcard then misses.
          routes.set(directory.slice(0, -1), { kind: 'file', file, mount })
        }
      }
    }
  }

  // Every URL the plugin answers, by its key as the router matches it: each file and index URL, and each directory.
  for (const [url, target] of routes) {
    if (target.kind === 'directory') {
      claimed.set(pathKey(url, router), { url, mount: target.mount, file: target.first })
    }
  }

  return { routes, taken: claimed }
}

function directoryRoute(
  routes: Map<string, RouteTarget>,
  directories: Map<string, string>,
  mount: PreparedMount,
  file: PreparedFile,
  slash: number,
  index: boolean,
  router: RouterFlags,
): void {
  const spelled = `${mount.prefix}${file.path.slice(0, slash)}/*`
  // Two directory spellings that the router matches as one route share their files.
  const normalized = pathKey(spelled, router)
  const url = directories.get(normalized) ?? spelled
  directories.set(normalized, url)
  const lookup = router.caseSensitive ? file.path.slice(slash + 1) : pathKey(mount.prefix + file.path, router)
  const route = routes.get(url)
  let files: Map<string, PreparedFile>

  if (route === undefined) {
    files = new Map([[lookup, file]])
    routes.set(url, { kind: 'directory', files, mount, first: file })
  } else if (route.kind === 'directory' && route.mount.anonymous === mount.anonymous) {
    files = route.files
    files.set(lookup, file)
  } else {
    // One route has one config: mounts that disagree on `anonymous` cannot share a directory.
    throw new ErrStaticRouteConflict(url, describe(route.mount, firstOf(route)), describe(mount, file))
  }

  if (index) {
    // The directory's URL reaches this wildcard with the index's directory as its capture: `''` for `/docs/`.
    const end = file.path.length - posix.basename(file.path).length
    const capture = file.path.slice(slash + 1, end)

    if (router.caseSensitive) {
      files.set(capture, file)
      if (router.ignoreTrailingSlash && capture !== '') {
        files.set(capture.slice(0, -1), file)
      }
    } else {
      files.set(pathKey(mount.prefix + file.path.slice(0, end), router), file)
    }
  }
}

/** The directory URLs an index file answers at: its directory, and a mount's prefix for one at the root. */
function indexURLs(mount: PreparedMount, file: PreparedFile, router: RouterFlags): string[] {
  const directory = mount.prefix + file.path.slice(0, file.path.length - posix.basename(file.path).length)

  // find-my-way matches the prefix without its slash too when it ignores trailing slashes.
  return directory === mount.prefix && mount.prefix !== '/' && !router.ignoreTrailingSlash
    ? [directory, directory.slice(0, -1)]
    : [directory]
}

function key(rest: string, router: RouterFlags): string {
  return router.caseSensitive ? rest : rest.toLowerCase()
}

function firstOf(target: RouteTarget): PreparedFile {
  return target.kind === 'directory' ? target.first : target.file
}

/** A file as a start-up error names it: its path from the working directory. */
function describe(mount: PreparedMount, file: PreparedFile): string {
  return relative(process.cwd(), join(mount.root, file.path)).split('\\').join('/')
}

function fileHandler(file: PreparedFile, log: FileLog): () => FileResponder {
  // A responder holds nothing of a request: one serves every request for the file.
  const responder = new FileResponder(file, 'route', log)
  return () => responder
}

/** The escapes find-my-way keeps while matching: `#`, `$`, `&`, `+`, `,`, `/`, `:`, `;`, `=`, `?` and `@`. */
const RESERVED_ESCAPE = /%(?:2[346BCF]|3[ABDF]|40)/i

function directoryHandler(
  files: ReadonlyMap<string, PreparedFile>,
  router: RouterFlags,
  log: FileLog,
): (ctx: IContext) => FileResponder {
  // One responder per file, built on its first request: it holds nothing of a request.
  const responders = new Map<PreparedFile, FileResponder>()

  return ctx => {
    // The router matches these escapes as written, then decodes them in the wildcard. An exact route at a file's URL
    // matches only the literal spelling, so the escaped one would reach the file here, under this route's gate; and
    // `%2F`, read as `/`, would reach a file by a URL another route answers. So they name nothing here either.
    const path = pathOf(ctx.req.url, router)
    let file: PreparedFile | undefined

    if (!RESERVED_ESCAPE.test(path)) {
      // Folding can expand a character in the prefix. The wildcard's offset would then skip part of the file name.
      const lookup = router.caseSensitive ? ctx.req.param('*') : pathKey(decodeURIComponent(path), router)
      file = lookup === undefined ? undefined : files.get(lookup)
    }

    if (file === undefined) {
      throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
    }

    let responder = responders.get(file)
    if (responder === undefined) {
      responder = new FileResponder(file, 'route', log)
      responders.set(file, responder)
    }

    return responder
  }
}
