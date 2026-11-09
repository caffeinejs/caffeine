import { join, posix, relative } from 'node:path'

import { ErrConfiguration, ErrHTTPNotFound } from '@caffeinejs/http'
import { authenticationExempt, type HTTPPluginConfigurer, type HTTPPluginFactory } from '@caffeinejs/http/fastify'
import { Day, Second, formatDuration, truncate } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { StaticBuilder, kBuild } from './builder.js'
import type { MountOptions, ResolvedMount } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { readManifest, type ManifestFile, type StaticManifest } from './manifest/manifest.js'
import { readFileEntry, scan } from './scan/scan.js'
import {
  prepareFile,
  rootOnDisk,
  serveFile,
  verifyHashes,
  writeHeaders,
  type FileDecision,
  type FilePolicy,
  type PreparedFile,
} from './serve.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/** The decoration `sendFile` reads the mounts from, off the server that serves the request. */
export const kStaticMounts = Symbol('caffeine.static.mounts')

/** One mount as `sendFile` finds it: its root as `.serve(...)` resolved it, and every file it lists. */
export interface ServedMount {
  readonly root: string
  readonly files: ReadonlyMap<string, PreparedFile>
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
  'content-encoding',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'x-content-type-options',
])

/**
 * Serves static files from a manifest, as an ordinary Fastify plugin factory: `.with(staticFiles(s => s.serve(root)))`.
 *
 * Each mount reads `static.manifest.json`, which `buildStatic()` from `@caffeinejs/static/build` writes, and serves
 * the files it lists and nothing else, every header computed at start-up: a request reads no file system metadata.
 * A file at the mount's root is a route of its own, and each directory under it is one route answering from the
 * files it lists, so a miss under a directory is a `404` and a miss elsewhere falls through to the application's
 * routes. Compressed variants are negotiated by `Accept-Encoding` and are never URLs of their own.
 *
 * Start-up fails loudly: a missing or stale manifest, a listed file that is not there, two files answering one URL,
 * and a URL another route already answers each name the file and the fix. Install it once per server; one
 * `staticFiles(...)` takes several `.serve(...)` calls.
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

    return staticPlugin(prepared, (fields, message) => context.logger.info(fields, message))
  }
}

async function prepareMount({ root, options }: ResolvedMount, allowProduction: boolean): Promise<PreparedMount> {
  const mode = options.mode ?? 'manifest'

  if (mode === 'scan' && isProduction() && !allowProduction) {
    throw new ErrStaticScanInProduction(root)
  }

  const policy = policyOf(root, options)
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
    prefix: prefixOf(options.prefix),
    anonymous: options.anonymous === true,
    index: options.index ?? 'index.html',
    mode,
    routed: prepared.filter(file => !unrouted.some(glob => posix.matchesGlob(file.path, glob))),
  }
}

/** The manifest a scan of `root` makes, every file hashed and none with variants. */
async function scanned(root: string): Promise<StaticManifest> {
  const { files } = await scan(root)
  const entries: Record<string, ManifestFile> = {}

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
  const directives = cacheControl
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
      : directives.join(', ')
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

    lowered[key] = value
  }

  return lowered
}

/** `'/'`, or the prefix with one leading and one trailing slash. */
function prefixOf(prefix: string | undefined): string {
  const trimmed = (prefix ?? '/').replace(/^\/+|\/+$/g, '')

  return trimmed === '' ? '/' : `/${trimmed}/`
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

function staticPlugin(
  mounts: readonly PreparedMount[],
  log: (fields: object, message: string) => void,
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    const router = routerOptionsOf(instance)
    const routes = routesOf(mounts, router)

    if (router.useSemicolonDelimiter) {
      assertNoSemicolon(mounts)
    }

    for (const [url, target] of routes) {
      if (answered(instance, url)) {
        throw new ErrStaticRouteConflict(url, describe(target.mount, firstOf(target)))
      }
    }

    // A file under a directory is answered by the directory's wildcard, which the router ranks below an exact route
    // at the file's URL: that route would answer the file, under its own gate, and the wildcard another spelling of it.
    for (const mount of mounts) {
      for (const file of mount.routed) {
        const url = mount.prefix + file.path

        if (!routes.has(url) && answered(instance, url)) {
          throw new ErrStaticRouteConflict(url, describe(mount, file))
        }
      }
    }

    instance.decorate(kStaticMounts, { mounts: mounts.map(({ root, files }) => ({ root, files })) })

    for (const [url, target] of routes) {
      instance.route({
        method: ['GET', 'HEAD'],
        url,
        ...(target.mount.anonymous ? { config: authenticationExempt() } : {}),
        handler: target.kind === 'file' ? fileHandler(target.file) : directoryHandler(target.files, router),
      })
    }

    // The same check for every route registered after the mount, compiled routes among them: the router refuses a
    // second route at a URL the mount registered itself, but not one at a file's URL under a directory.
    const underDirectories = new Map<string, { mount: PreparedMount; file: PreparedFile }>()

    for (const mount of mounts) {
      for (const file of mount.routed) {
        const url = mount.prefix + file.path

        if (!routes.has(url)) {
          underDirectories.set(key(url, router), { mount, file })
        }
      }
    }

    instance.addHook('onRoute', route => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      const served = underDirectories.get(key(effectivePath(route.url, router), router))

      if (served !== undefined && methods.some(method => method === 'GET' || method === 'HEAD')) {
        throw new ErrStaticRouteConflict(route.url, describe(served.mount, served.file))
      }
    })

    for (const mount of mounts) {
      log(
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

  return fp(plugin, { name: '@caffeinejs/static' })
}

interface RouterFlags {
  readonly caseSensitive: boolean
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  readonly useSemicolonDelimiter: boolean
}

function routerOptionsOf(instance: FastifyInstance): RouterFlags {
  // Fastify's options schema defaults both top-level flags, so only `routerOptions` may leave one out.
  const config = instance.initialConfig as {
    routerOptions?: {
      caseSensitive?: boolean
      ignoreTrailingSlash?: boolean
      ignoreDuplicateSlashes?: boolean
      useSemicolonDelimiter?: boolean
    }
    caseSensitive: boolean
    ignoreTrailingSlash: boolean
    ignoreDuplicateSlashes: boolean
    useSemicolonDelimiter: boolean
  }

  return {
    caseSensitive: config.routerOptions?.caseSensitive ?? config.caseSensitive,
    ignoreTrailingSlash: config.routerOptions?.ignoreTrailingSlash ?? config.ignoreTrailingSlash,
    ignoreDuplicateSlashes: config.routerOptions?.ignoreDuplicateSlashes ?? config.ignoreDuplicateSlashes,
    useSemicolonDelimiter: config.routerOptions?.useSemicolonDelimiter ?? config.useSemicolonDelimiter,
  }
}

/** The path of a request URL, where the router ends it: at `?`, or at `;` too when it reads one as the query's start. */
function pathOf(url: string, router: RouterFlags): string {
  const end = router.useSemicolonDelimiter ? url.search(/[?;]/) : url.indexOf('?')

  return end === -1 ? url : url.slice(0, end)
}

/**
 * Refuses a routed file with `;` in its name where the router reads `;` as the start of the query: its URL ends
 * before the `;`, and `%3B` is no name under a directory, so nothing would reach it.
 */
function assertNoSemicolon(mounts: readonly PreparedMount[]): void {
  for (const mount of mounts) {
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

/** Whether a route of the server answers a GET or a HEAD at `url`: either one answers the file. */
function answered(instance: FastifyInstance, url: string): boolean {
  return instance.hasRoute({ method: 'GET', url }) || instance.hasRoute({ method: 'HEAD', url })
}

/** The path the router registers for a route written as `url`, case aside: what it matches, slashes folded. */
function effectivePath(url: string, router: RouterFlags): string {
  const collapsed = router.ignoreDuplicateSlashes ? url.replace(/\/{2,}/g, '/') : url

  return router.ignoreTrailingSlash && collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

/**
 * The routes every mount registers, checked for two files answering one URL as the router would match it: a file at
 * a mount's root and each index directory has its own route, and each directory under the root one route answering
 * from its files.
 */
function routesOf(mounts: readonly PreparedMount[], router: RouterFlags): Map<string, RouteTarget> {
  const fold = (url: string) => {
    const cased = router.caseSensitive ? url : url.toLowerCase()

    return router.ignoreTrailingSlash && cased.length > 1 ? cased.replace(/\/$/, '') : cased
  }
  const claimed = new Map<string, { mount: PreparedMount; file: PreparedFile }>()
  // Each directory route's URL as first spelled, by its URL as the router matches it.
  const directories = new Map<string, string>()
  const claim = (url: string, mount: PreparedMount, file: PreparedFile) => {
    const key = fold(url)
    const held = claimed.get(key)

    if (held !== undefined) {
      throw new ErrStaticRouteConflict(url, describe(held.mount, held.file), describe(mount, file))
    }

    claimed.set(key, { mount, file })
  }
  const routes = new Map<string, RouteTarget>()

  for (const mount of mounts) {
    for (const file of mount.routed) {
      claim(mount.prefix + file.path, mount, file)

      const slash = file.path.indexOf('/')

      if (slash === -1) {
        routes.set(mount.prefix + file.path, { kind: 'file', file, mount })
      } else {
        directoryRoute(routes, directories, mount, file, slash, router)
      }

      if (mount.index !== false && posix.basename(file.path) === mount.index) {
        for (const url of indexURLs(mount, file, router)) {
          claim(url, mount, file)
          routes.set(url, { kind: 'file', file, mount })
        }
      }
    }
  }

  // find-my-way gives a request to the longest wildcard that takes it: a nested mount's directory route would answer,
  // and miss, the other's files under it.
  const caseOf = (url: string) => (router.caseSensitive ? url : url.toLowerCase())
  const bases = [...routes].flatMap(([url, target]) =>
    target.kind === 'directory' ? [{ base: caseOf(url.slice(0, -1)), target }] : [],
  )

  for (const { target } of bases) {
    for (const file of target.files.values()) {
      const url = target.mount.prefix + file.path
      const nearest = bases
        .filter(({ base }) => caseOf(url).startsWith(base))
        .reduce((a, b) => (b.base.length > a.base.length ? b : a), { base: '', target })

      if (nearest.target !== target) {
        throw new ErrStaticRouteConflict(
          url,
          describe(target.mount, file),
          describe(nearest.target.mount, firstOf(nearest.target)),
        )
      }
    }
  }

  return routes
}

function directoryRoute(
  routes: Map<string, RouteTarget>,
  directories: Map<string, string>,
  mount: PreparedMount,
  file: PreparedFile,
  slash: number,
  router: RouterFlags,
): void {
  const spelled = `${mount.prefix}${file.path.slice(0, slash)}/*`
  // A router that folds case matches `/Assets/*` and `/assets/*` as one route: the files of both share it.
  const folded = router.caseSensitive ? spelled : spelled.toLowerCase()
  const url = directories.get(folded) ?? spelled
  directories.set(folded, url)
  const rest = file.path.slice(slash + 1)
  const route = routes.get(url)

  if (route === undefined) {
    routes.set(url, { kind: 'directory', files: new Map([[key(rest, router), file]]), mount, first: file })
  } else if (route.kind === 'directory' && route.mount.anonymous === mount.anonymous) {
    route.files.set(key(rest, router), file)
  } else {
    // One route has one config: mounts that disagree on `anonymous` cannot share a directory.
    throw new ErrStaticRouteConflict(url, describe(route.mount, firstOf(route)), describe(mount, file))
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
  return target.kind === 'file' ? target.file : target.first
}

/** A file as a start-up error names it: its path from the working directory. */
function describe(mount: PreparedMount, file: PreparedFile): string {
  return relative(process.cwd(), join(mount.root, file.path)).split('\\').join('/')
}

function fileHandler(file: PreparedFile) {
  return (request: FastifyRequest, reply: FastifyReply) => answer(request, reply, decide(file, request))
}

/** The escapes find-my-way keeps while matching: `#`, `$`, `&`, `+`, `,`, `/`, `:`, `;`, `=`, `?` and `@`. */
const RESERVED_ESCAPE = /%(?:2[346BCF]|3[ABDF]|40)/i

function directoryHandler(files: ReadonlyMap<string, PreparedFile>, router: RouterFlags) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // The router matches these escapes as written, then decodes them in the wildcard. An exact route at a file's URL
    // matches only the literal spelling, so the escaped one would reach the file here, under this route's gate; and
    // `%2F`, read as `/`, would reach a file by a URL another route answers. So they name nothing here either.
    const escaped = RESERVED_ESCAPE.test(pathOf(request.url, router))
    const file = escaped ? undefined : files.get(key((request.params as { '*': string })['*'], router))

    if (file === undefined) {
      throw new ErrHTTPNotFound(`Route ${request.method}:${request.url} not found`)
    }

    return answer(request, reply, decide(file, request))
  }
}

function decide(file: PreparedFile, request: FastifyRequest): Promise<FileDecision> {
  return serveFile(
    file,
    {
      method: request.method,
      header: name => {
        const value = request.headers[name]
        return typeof value === 'string' ? value : undefined
      },
    },
    { via: 'route', conditional: true, log: request.log },
  )
}

/** Sends what `deciding` settles to, unless the request was answered meanwhile, by a timeout's 503 most likely. */
async function answer(
  request: FastifyRequest,
  reply: FastifyReply,
  deciding: Promise<FileDecision>,
): Promise<FastifyReply> {
  let decision: FileDecision

  try {
    decision = await deciding
  } catch (err) {
    // A failure after the timeout is as late as the file would have been: the 503 answers, sent or still in a hook.
    if (reply.sent || timedOut(request)) {
      request.log.error({ err }, 'Static file failed after its timeout; the 503 stands')
      return reply
    }

    throw err
  }

  return send(reply, decision)
}

function send(reply: FastifyReply, decision: FileDecision): FastifyReply {
  // The handler timed out while the file opened: the 503 answers, sent or still in a hook, and nothing would close the
  // file. A timed route's signal says which, not `reply.sent`, which stays false while a hook holds the 503.
  if (reply.sent || timedOut(reply.request)) {
    decision.body?.destroy()

    return reply
  }

  writeHeaders(reply.code(decision.status), decision.headers)

  if (decision.cacheControl !== undefined) {
    reply.header('cache-control', decision.cacheControl)
  }

  return reply.send(decision.body)
}

/**
 * Whether Fastify's handler timeout fired. Read only on a timed route, which has built its signal already; its other
 * abort is the request's close, which is not the client leaving.
 */
function timedOut(request: FastifyRequest): boolean {
  return (
    request.routeOptions.handlerTimeout > 0 &&
    request.signal.aborted &&
    (request.signal.reason as { code?: unknown } | null)?.code === 'FST_ERR_HANDLER_TIMEOUT'
  )
}
