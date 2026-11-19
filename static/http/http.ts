import {
  accessControlExempt,
  ErrConfiguration,
  ErrHTTPInternalServerError,
  ErrHTTPNotFound,
  ErrHTTPPreconditionFailed,
  ErrRouteConflict,
  findMyWayMatcher,
  HTTPPlugin,
  kRouteConstraints,
  Responder,
  Router,
  type ActionResult,
  type HTTPPluginFactory,
  type HTTPPluginConfigurer,
  type HTTPSetupContext,
  type IContext,
  type RouteDefinition,
  type RouteMatcher,
  type RouterFlags,
} from '@caffeinejs/http'
import { Day, Second, formatDuration, truncate } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import type { AssetMountOptions } from '../config.js'
import { ErrSendFileUnavailable, ErrStaticRouteConflict } from '../errors.js'
import { isRelativePath, nameProblem, type ManifestFile } from '../manifest/manifest.js'
import {
  decideFile,
  prepareResponseFile,
  writeHeaders,
  type FileDecision,
  type FileLog,
  type FilePolicy,
  type PreparedFile,
} from '../response/index.js'
import { openAssetBody, releaseOf, type VerifiedStaticAssets } from '../web/web.js'

type StaticLog = FileLog & { info(fields: object, message: string): void }
type MatchPattern = (path: string, pattern: string) => boolean
type ValidateHeader = (name: string, value: string) => void

export type OpenFile = (
  representation: NonNullable<FileDecision['representation']>,
  range: FileDecision['range'],
  ctx: IContext,
  log: FileLog,
) => Promise<{ body: ActionResult; close(): void | Promise<void> }>

interface MountedFile extends PreparedFile {
  readonly verified: boolean
  readonly open: OpenFile
}

interface ServedMounts {
  readonly mounts: readonly PreparedMount[]
  readonly log: FileLog
}

const mountsByRoute = new WeakMap<RouteDefinition, ServedMounts>()
const activeBodies = new WeakMap<IContext, Set<Awaited<ReturnType<typeof openAssetBody>>>>()

interface PreparedMount {
  readonly root: string
  readonly assets?: VerifiedStaticAssets
  readonly files: ReadonlyMap<string, MountedFile>
  readonly prefix: string
  readonly anonymous: boolean
  readonly index: string | false
  readonly mode: 'manifest' | 'scan'
  readonly routed: readonly MountedFile[]
  describe(path: string): string
}

const kStaticRoute = 'caffeine:static-route'
const STATIC_ROUTE: unique symbol = Symbol('caffeine.static.route')
const OTHER: unique symbol = Symbol('caffeine.static.other-route')

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

const kMounts = Symbol('caffeine.static.assets')

/** Configures mounts of verified assets on one application or listener. */
export class StaticAssetsBuilder {
  #mounts: PreparedMount[] = []

  /** Serves a verified release under this mount's routing and cache policy. */
  serve(assets: VerifiedStaticAssets, options: AssetMountOptions = {}): this {
    this.#mounts.push(prepareAssets(assets, options))
    return this
  }

  [kMounts](): readonly PreparedMount[] {
    return this.#mounts
  }
}

export type StaticAssetsConfigurer<C = unknown> = HTTPPluginConfigurer<StaticAssetsBuilder, C>

/** Installs static mounts backed by verified sources. */
export function staticFiles<C = unknown>(configure?: StaticAssetsConfigurer<C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new StaticAssetsBuilder()
    configure?.(builder, context)
    return new StaticFiles(builder[kMounts](), context.logger)
  }
}

export function prepareMount(
  details: Omit<PreparedMount, 'files' | 'routed' | 'prefix' | 'index' | 'anonymous'>,
  options: AssetMountOptions,
  files: readonly PreparedFile[],
  open: OpenFile,
  match: MatchPattern,
): PreparedMount {
  const unrouted = options.unrouted ?? []
  const prepared = files.map(file => ({ ...file, open, verified: details.assets !== undefined }))
  return {
    ...details,
    files: new Map(prepared.map(file => [file.path, file])),
    prefix: prefixOf(details.root, options.prefix),
    index: options.index ?? 'index.html',
    anonymous: options.anonymous === true,
    routed: unrouted.includes('**')
      ? []
      : prepared.filter(file => !unrouted.some(pattern => match(file.path, pattern))),
  }
}

export function prepareAssets(assets: VerifiedStaticAssets, options: AssetMountOptions): PreparedMount {
  const release = releaseOf(assets)
  const root = 'verified static assets'
  if (release === undefined) {
    throw mountError(
      'Cannot mount static assets: the handle was not verified',
      'Pass the result of verifyStaticAssets()',
    )
  }
  if ('mode' in options) {
    throw mountError(
      'Cannot mount static assets: mode applies to directory mounts',
      'Remove mode from the mount options',
    )
  }
  for (const pattern of [...(options.unrouted ?? []), ...(options.immutable ?? [])]) {
    const path = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    if (pattern !== '**' && (!isRelativePath(path) || nameProblem(path, true) !== undefined)) {
      throw mountError(
        `Cannot mount static assets: "${pattern}" is not a supported pattern`,
        'Use an exact key, "directory/**" or "**"',
      )
    }
  }

  const match: MatchPattern = (path, pattern) =>
    pattern === '**' || (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern)
  const policy = policyOf(
    root,
    {
      ...options,
      headers: options.headers && ((entry, key) => options.headers!(structuredClone(entry), key)),
    },
    match,
    (name, value) => {
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new TypeError('Invalid header value')
      }
      new Headers([[name, value]])
    },
  )
  const files = Object.entries(release.manifest.files).map(([key, entry]) => prepareResponseFile(key, entry, policy))
  const open: OpenFile = async (representation, range, ctx, log) => {
    const { signal } = ctx
    try {
      const body = await openAssetBody(release, representation, range, signal)
      if (ctx.sent || signal.aborted) {
        void body.close(signal.reason)
        return { body: undefined, close: () => undefined }
      }
      let bodies = activeBodies.get(ctx)
      if (bodies === undefined) {
        bodies = new Set()
        activeBodies.set(ctx, bodies)
      }
      bodies.add(body)
      return { body: body.stream, close: () => body.close() }
    } catch (err) {
      if (ctx.sent || signal.aborted) {
        return { body: undefined, close: () => undefined }
      }
      log.error({ err, path: representation.path, reqId: ctx.req.id }, 'Cannot open a static file the manifest lists')
      throw new ErrHTTPInternalServerError()
    }
  }
  return prepareMount({ root, mode: 'manifest', assets, describe: path => path }, options, files, open, match)
}

function mountError(message: string, solution: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(message).solutions(solution).reference('@caffeinejs/http', ErrConfiguration).build(),
  )
}

/**
 * Decides `Cache-Control` and the extra headers per file, refusing an option that would override what the mount
 * derives.
 */
export function policyOf(
  root: string,
  options: AssetMountOptions,
  match: MatchPattern,
  validate: ValidateHeader,
): FilePolicy {
  const cacheControl = options.cacheControl ?? 'no-cache'
  assertHeader(root, 'cacheControl', 'cache-control', cacheControl, validate)

  const scope = cacheDirectives(cacheControl).find(directive =>
    /^(?:public|private)$/i.test(directive.split('=', 1)[0]!.trim()),
  )

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
    immutable.some(glob => match(path, glob))
      ? `max-age=${Math.floor(maxAge / Second)}, immutable`
      : cacheControl.trim()
  const scoped = (scopeName: string, path: string) => [scopeName, directive(path)].filter(Boolean).join(', ')
  const routeScope = options.anonymous === true ? 'public' : 'private'

  return {
    routeCacheControl: path => scoped(routeScope, path),
    sendFileCacheControl: path => scoped('private', path),
    headers: (path, file) => extraHeaders(root, path, file, options.headers, validate),
  }
}

/** Splits cache directives at commas outside quoted values. */
function cacheDirectives(value: string): string[] {
  return value
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .split(',')
    .map(directive => directive.trim())
    .filter(Boolean)
}

function extraHeaders(
  root: string,
  path: string,
  file: ManifestFile,
  headers: AssetMountOptions['headers'],
  validate: ValidateHeader,
): Readonly<Record<string, string>> | undefined {
  const given = headers?.(file, path)

  if (given === undefined) {
    return undefined
  }

  const lowered: Record<string, string> = {}

  for (const [name, value] of Object.entries(given)) {
    const key = name.toLowerCase()

    // Response headers use plain records, where this key sets the prototype.
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

    assertHeader(root, `headers(file) for "${path}"`, name, value, validate)
    lowered[key] = value
  }

  return lowered
}

function assertHeader(root: string, option: string, name: string, value: string, validate: ValidateHeader): void {
  try {
    validate(name, value)
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

/** A URL the plugin registers, and what answers it. */
type RouteTarget =
  | { readonly kind: 'file'; readonly file: MountedFile; readonly mount: PreparedMount }
  | {
      readonly kind: 'directory'
      readonly files: Map<string, MountedFile>
      readonly mount: PreparedMount
      readonly first: MountedFile
    }
  | { readonly kind: 'root-index'; readonly file: MountedFile; readonly mount: PreparedMount }

/** A URL the plugin claims, and the file that answers it. */
interface Claim {
  readonly url: string
  readonly mount: PreparedMount
  readonly file: MountedFile
}

/** The router as the plugin models it, to ask which route answers a URL. */
type StaticMatcher = RouteMatcher<RouteTarget | typeof OTHER>

export class StaticFiles extends HTTPPlugin {
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
    const assets = new Set<VerifiedStaticAssets>()
    for (const mount of mounts) {
      if (mount.assets !== undefined) {
        if (assets.has(mount.assets)) {
          throw mountError(
            'Cannot mount static assets: this server already serves the handle',
            'Keep one .serve(assets) call for this handle',
          )
        }
        assets.add(mount.assets)
      }
    }
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

    const served: ServedMounts = { mounts, log }
    if (mounts.some(mount => mount.assets !== undefined)) {
      context.app.hook('onResponse', ctx => {
        const bodies = activeBodies.get(ctx)
        activeBodies.delete(ctx)
        for (const body of bodies ?? []) {
          void body.close()
        }
      })
    }
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
  const claim = (url: string, mount: PreparedMount, file: MountedFile) => {
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
      const index = mount.index !== false && file.path.slice(file.path.lastIndexOf('/') + 1) === mount.index

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
  file: MountedFile,
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
  let files: Map<string, MountedFile>

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
    const end = file.path.length - file.path.slice(file.path.lastIndexOf('/') + 1).length
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
function indexURLs(mount: PreparedMount, file: MountedFile, router: RouterFlags): string[] {
  const directory =
    mount.prefix + file.path.slice(0, file.path.length - file.path.slice(file.path.lastIndexOf('/') + 1).length)

  // find-my-way matches the prefix without its slash too when it ignores trailing slashes.
  return directory === mount.prefix && mount.prefix !== '/' && !router.ignoreTrailingSlash
    ? [directory, directory.slice(0, -1)]
    : [directory]
}

function key(rest: string, router: RouterFlags): string {
  return router.caseSensitive ? rest : rest.toLowerCase()
}

function firstOf(target: RouteTarget): MountedFile {
  return target.kind === 'directory' ? target.first : target.file
}

/** A file as a start-up error names it: its path from the working directory. */
function describe(mount: PreparedMount, file: MountedFile): string {
  return mount.describe(file.path)
}

function fileHandler(file: MountedFile, log: FileLog): () => FileResponder {
  // A responder holds nothing of a request: one serves every request for the file.
  const responder = new FileResponder(file, 'route', log)
  return () => responder
}

/** The escapes find-my-way keeps while matching: `#`, `$`, `&`, `+`, `,`, `/`, `:`, `;`, `=`, `?` and `@`. */
const RESERVED_ESCAPE = /%(?:2[346BCF]|3[ABDF]|40)/i

function directoryHandler(
  files: ReadonlyMap<string, MountedFile>,
  router: RouterFlags,
  log: FileLog,
): (ctx: IContext) => FileResponder {
  // One responder per file, built on its first request: it holds nothing of a request.
  const responders = new Map<MountedFile, FileResponder>()

  return ctx => {
    // The router matches these escapes as written, then decodes them in the wildcard. An exact route at a file's URL
    // matches only the literal spelling, so the escaped one would reach the file here, under this route's gate; and
    // `%2F`, read as `/`, would reach a file by a URL another route answers. So they name nothing here either.
    const path = pathOf(ctx.req.url, router)
    let file: MountedFile | undefined

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
/**
 * The slice of an `IContext` {@link sendFile} reads: the route, whose server's mounts it sends from. A structural
 * slice, so every context fits.
 */
export interface StaticContext {
  readonly route: RouteDefinition | undefined
}

/** Sends one manifest key from a verified mount on the current server. */
export function sendFile(ctx: StaticContext, path: string, assets?: VerifiedStaticAssets): Responder {
  return sendMountedFile(ctx, path, assets)
}

export function sendMountedFile(ctx: StaticContext, path: string, selector?: string | VerifiedStaticAssets): Responder {
  const route = ctx.route
  if (route === undefined) {
    throw new ErrSendFileUnavailable(undefined, false, false)
  }
  const served = mountsByRoute.get(route)
  if (served === undefined) {
    throw new ErrSendFileUnavailable()
  }

  const mount =
    selector === undefined
      ? served.mounts[0]
      : typeof selector === 'string'
        ? served.mounts.find(candidate => candidate.assets === undefined && candidate.root === selector)
        : served.mounts.find(candidate => candidate.assets === selector)

  if (mount === undefined) {
    if (selector !== undefined && typeof selector !== 'string') {
      throw mountError(
        'Cannot send a file: this server has no mount for the verified handle',
        'Mount the handle with .serve(assets) on this server',
      )
    }
    throw new ErrSendFileUnavailable(selector, true)
  }

  const key = mount.assets === undefined ? manifestKey(path) : path
  const file = key === undefined ? undefined : mount.files.get(key)
  if (file === undefined) {
    throw new ErrHTTPNotFound()
  }

  return new FileResponder(file, 'sendFile', served.log)
}

/** The manifest key `path` names: itself, or for a URL path, the path without its leading `/`, each segment decoded. */
function manifestKey(path: string): string | undefined {
  if (!path.startsWith('/')) {
    return path
  }

  try {
    const segments = path
      .slice(1)
      .split('/')
      .map(segment => decodeURIComponent(segment))

    return segments.some(segment => segment.includes('/')) ? undefined : segments.join('/')
  } catch {
    return undefined
  }
}

class FileResponder extends Responder {
  constructor(
    readonly file: MountedFile,
    readonly via: 'route' | 'sendFile',
    readonly log: FileLog,
  ) {
    super()
  }

  async respond(ctx: IContext): Promise<ActionResult> {
    const method = ctx.req.method
    const conditional = this.via === 'route' || ((method === 'GET' || method === 'HEAD') && ctx.statusCode === 200)
    const signal = ctx.signal
    const { status, headers, cacheControl, representation, range } = decideFile(this.file, ctx.req, {
      via: this.via,
      conditional,
    })
    if (status === 412) {
      throw new ErrHTTPPreconditionFailed()
    }
    const outgoing = conditional ? status : ctx.statusCode
    const bodyless = this.file.verified && (outgoing === 204 || outgoing === 205 || outgoing === 304)
    const body =
      representation !== undefined && !bodyless ? await this.file.open(representation, range, ctx, this.log) : undefined
    if (ctx.sent || signal.aborted) {
      void body?.close()
      return undefined
    }

    try {
      writeHeaders(ctx.status(outgoing), headers)
      // These statuses never send a body. The engine normally drops the file stream and its entity length.
      if (bodyless && outgoing !== 205) {
        ctx.removeHeader('content-length')
        if (outgoing === 204) {
          ctx.removeHeader('content-type')
        }
      }
      if (cacheControl !== undefined) {
        const priorCache = ctx.getHeader('cache-control')
        if (
          priorCache === undefined ||
          !cacheDirectives(String(priorCache)).some(directive => /^no-store$/i.test(directive))
        ) {
          ctx.header('cache-control', cacheControl)
        }
      }
    } catch (err) {
      void body?.close()
      throw err
    }

    if (body !== undefined) {
      return body.body
    }

    // The engine's automatic HEAD route preserves the selected length when it sees a stream.
    if (method === 'HEAD' && !bodyless && headers['content-length'] !== undefined) {
      return new ReadableStream({ start: controller => controller.close() })
    }
    return undefined
  }
}
