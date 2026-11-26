import { validateHeaderName, validateHeaderValue } from 'node:http'
import { join, posix, relative } from 'node:path'

import {
  accessControlExempt,
  ErrConfiguration,
  ErrHTTPNotFound,
  ErrRouteConflict,
  findMyWayMatcher,
  HTTPPlugin,
  literalPrefix,
  normalizeRoutePath,
  parseRoutePattern,
  Router,
  type HTTPPluginFactory,
  type HTTPPluginConfigurer,
  type HTTPSetupContext,
  type IContext,
  type RouteMatcher,
} from '@caffeinejs/http'
import { Day, Second, formatDuration, truncate } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { StaticBuilder, kBuild } from './builder.js'
import type { MountOptions, ResolvedMount } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { nameProblem, type ManifestFile, type StaticManifest } from './manifest/manifest.js'
import { readManifest } from './manifest/read.js'
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

/** Where a route keeps the mounts of the `staticFiles()` covering it, for `sendFile`. */
export const kServedMounts: unique symbol = Symbol('caffeine.static.served-mounts')

/** Where the plugin logs: a failed open, and one line per mount at start-up. */
type StaticLog = FileLog & { info(fields: object, message: string): void }

declare module '@caffeinejs/http' {
  interface RouteOptions {
    /** Marks one `staticFiles(...)`'s own routes, so its checks pass over them and check another's. */
    staticRoute?: symbol
    /** Written by `staticFiles()` for every route it covers: the mounts `sendFile` reads. */
    [kServedMounts]?: ServedMounts
  }
}

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
 * Start-up fails loudly: a missing or stale manifest, a listed file that is not there, and two files answering one
 * URL each name the file and the fix. Application routes are not checked against the files: one at exactly a file's
 * URL fails start-up as a duplicate route (`ErrRouteConflict`), and one under a directory of files wins. Install it
 * once where it serves: on the application or a listener it serves at the server's paths, on a router or a
 * controller under that one's path. A server with a matcher of its own is refused. One `staticFiles(...)` takes
 * several `.serve(...)` calls.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): HTTPPluginFactory<C> {
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
  const normalized = `${literalPrefix(prefix ?? '/').exact}/`
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

/** A URL the plugin claims, and the file that answers it. */
interface Claim {
  readonly mount: PreparedMount
  readonly file: PreparedFile
}

/** The router as the plugin models it, to ask which route answers a URL. */
type StaticMatcher = RouteMatcher<RouteTarget>

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
    const { server } = context
    // Where the plugin's routes start: what it mounts nests under it, so the URLs below are relative to it.
    const prefix = server.prefix
    // A URL the plugin answers, as a refusal names it: where the server serves it.
    const atServer = (url: string): string => `${prefix}${url}`

    if (server.matcher !== findMyWayMatcher) {
      throw new ErrConfiguration(
        errMessage(
          'Cannot install staticFiles(): the server matches routes with a matcher of its own, and static routes are matched by find-my-way',
        )
          .solutions('Leave the matcher setting out of ".server(...)" on the server that serves static files')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    const routes = routesOf(mounts)
    // This registration's own routes, which its checks hold.
    const mine = Symbol('caffeine.static.route')
    const served: ServedMounts = { mounts: mounts.map(({ root, files }) => ({ root, files })), log }

    context.server.hook('onRoute', route => {
      // A second `staticFiles(...)` over the route adds its mounts: `sendFile` finds either by its root.
      const prior = route.options[kServedMounts]
      route.options[kServedMounts] =
        prior === undefined ? served : { mounts: [...prior.mounts, ...served.mounts], log: prior.log }
    })

    // Once every route is in, the router's own rules say what answers each file under a directory: a longer wildcard
    // between this registration's mounts ranks above the directory's wildcard and would answer the file under its
    // own gate. Asked of a find-my-way, which is how the server matches.
    context.server.hook('onReady', () => {
      const matcher: StaticMatcher = findMyWayMatcher<RouteTarget>([])
      const hold = (method: string, url: string, store: RouteTarget) => {
        try {
          matcher.add(method, url, undefined, store)
        } catch (err) {
          // A path already held answers the same: a second spelling of one of the registration's routes.
          if (!(err instanceof ErrRouteConflict)) {
            throw err
          }
        }
      }

      for (const [url, target] of routes) {
        for (const method of ['GET', 'HEAD']) {
          hold(method, url, target)
        }
      }

      // After every other route, as the server registers it: a directory's wildcard answers its bare parent too.
      for (const [url, target] of routes) {
        if (target.kind === 'directory' && url !== '/*') {
          for (const method of ['GET', 'HEAD']) {
            hold(method, url.slice(0, -2), target)
          }
        }
      }

      for (const mount of mounts) {
        for (const file of mount.routed) {
          const url = mount.prefix + file.path

          if (!routes.has(url) && !answeredByMount(matcher, url, file.path.slice(file.path.indexOf('/') + 1))) {
            const nested = nestedDirectory(matcher, url, mount, routes)

            throw nested === undefined
              ? new ErrStaticRouteConflict(atServer(url), describe(mount, file))
              : new ErrStaticRouteConflict(
                  atServer(url),
                  describe(mount, file),
                  describe(nested.mount, firstOf(nested)),
                )
          }
        }
      }
    })

    const open = staticRouter(mine).config(accessControlExempt())
    const guarded = staticRouter(mine)
    const mounted = new Set<Router>()
    let n = 0

    for (const [url, target] of routes) {
      const into = target.mount.anonymous ? open : guarded
      mounted.add(into)
      into
        .get(url)
        .name(`static_${n++}`)
        .handler(target.kind === 'file' ? fileHandler(target.file, log) : directoryHandler(target.files, log, prefix))
    }

    context.server.mount(...mounted)

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
function staticRouter(mine: symbol): Router {
  return new Router().detail('http', { internal: true }).config({ staticRoute: mine })
}

/** The parameters of the route `matcher` hands `url` to, or `undefined` for none or a spelling it cannot decode. */
function paramsOf(matcher: StaticMatcher, method: string, url: string): Record<string, string | undefined> | undefined {
  try {
    return matcher.match(method, url, undefined)?.params
  } catch {
    return undefined
  }
}

/** The path of a request target, with the authority and query removed as the router removes them. */
function pathOf(url: string): string {
  // An absolute-form target reaches a directory route only with a path after its authority.
  const path = url.startsWith('/') ? url : url.slice(url.indexOf('/', url.indexOf('://') + 3))
  const end = path.search(/[?#]/)

  return end === -1 ? path : path.slice(0, end)
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
): RouteTarget | undefined {
  const params = paramsOf(matcher, 'GET', encodeURI(url))
  const star = params?.['*']

  if (star === undefined || !url.endsWith(star)) {
    return undefined
  }

  const taken = url.slice(0, url.length - star.length)

  for (const [other, target] of routes) {
    if (target.kind === 'directory' && target.mount !== mount && other.slice(0, -1) === taken) {
      return target
    }
  }

  return undefined
}

/**
 * Whether the router hands a GET and a HEAD at `url` to the directory route that serves `rest`, the file's path under
 * its directory, rather than to another route.
 */
function answeredByMount(matcher: StaticMatcher, url: string, rest: string): boolean {
  // Spelled as a browser sends it, which the router decodes as it does a request's.
  const sent = encodeURI(url)

  return ['GET', 'HEAD'].every(method => {
    const params = paramsOf(matcher, method, sent)

    return params !== undefined && Object.keys(params).length === 1 && params['*'] === rest
  })
}

/**
 * The routes every mount registers, checked for two files answering one URL as the router would match it: a file at
 * a mount's root and an index at a mount's root have their own route, and each directory under the root one route
 * answering from its files, index URLs included.
 */
function routesOf(mounts: readonly PreparedMount[]): Map<string, RouteTarget> {
  const claimed = new Map<string, Claim>()
  const claim = (url: string, mount: PreparedMount, file: PreparedFile) => {
    const normalized = normalizeRoutePath(url)
    const held = claimed.get(normalized)

    if (held !== undefined) {
      throw new ErrStaticRouteConflict(url, describe(held.mount, held.file), describe(mount, file))
    }

    claimed.set(normalized, { mount, file })
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
        directoryRoute(routes, mount, file, slash, index)
      }

      if (index) {
        const directory = indexURL(mount, file)
        claim(directory, mount, file)

        if (directory === mount.prefix) {
          routes.set(normalizeRoutePath(directory), { kind: 'file', file, mount })
        }
      }
    }
  }

  return routes
}

function directoryRoute(
  routes: Map<string, RouteTarget>,
  mount: PreparedMount,
  file: PreparedFile,
  slash: number,
  index: boolean,
): void {
  const url = `${mount.prefix}${file.path.slice(0, slash)}/*`
  const lookup = file.path.slice(slash + 1)
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

    // Without its trailing slash, as the router hands it over: `''` stays `''`.
    files.set(capture.slice(0, -1), file)
  }
}

/** The directory URL an index file answers at. */
function indexURL(mount: PreparedMount, file: PreparedFile): string {
  return mount.prefix + file.path.slice(0, file.path.length - posix.basename(file.path).length)
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
  log: FileLog,
  prefix: string,
): (ctx: IContext) => FileResponder {
  // The files are keyed by their URL under the plugin's scope, and a request's path starts with the scope's. The
  // scope's path is a pattern whose every parameter is one segment, so its own segments are taken off, whatever they
  // hold, before anything below reads the path.
  const segments = segmentsOf(prefix)
  // One responder per file, built on its first request: it holds nothing of a request.
  const responders = new Map<PreparedFile, FileResponder>()

  const withinScope = (path: string): string =>
    segments === 0
      ? path
      : `/${path
          .split('/')
          .slice(segments + 1)
          .join('/')}`

  return ctx => {
    // The router matches these escapes as written, then decodes them in the wildcard. An exact route at a file's URL
    // matches only the literal spelling, so the escaped one would reach the file here, under this route's gate; and
    // `%2F`, read as `/`, would reach a file by a URL another route answers. So they name nothing here either.
    const path = withinScope(pathOf(ctx.req.url))
    let file: PreparedFile | undefined

    if (!RESERVED_ESCAPE.test(path)) {
      const lookup = ctx.req.param('*')
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

/**
 * How many segments of a request path the scope's path spans, where the file URLs under it begin: a parameter is one
 * segment whatever its value. The scope's path holds literal segments and parameters only: `normalizeGroupPath` refuses
 * a wildcard or an optional segment in it.
 */
function segmentsOf(prefix: string): number {
  const joined = `${parseRoutePattern(prefix)
    .map(part => (part.kind === 'text' ? part.text : 'p'))
    .join('')}/x`
  return joined.split('/').length - 2
}
