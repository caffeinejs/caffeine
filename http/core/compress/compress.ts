import { KiB, type ByteSize } from '@caffeinejs/std/bytes'

import type { IContext } from '../../context.js'
import { HTTPPlugin, type HTTPPluginConfigurer, type HTTPPluginFactory, type HTTPSetupContext } from '../../plugin.js'
import { appendVary } from '../../vary.js'
import { preconditionFailed } from '../conditional/conditional.js'
import type { ErrConfiguration } from '../error/common.js'
import type { SendPayload } from '../lifecycle/lifecycle.js'
import type { RouteDefinition } from '../lifecycle/route_definition.js'
import type { AnyRouteExtension } from '../routing/extension.js'
import { configurationError } from '../server/error.js'
import { isOptions } from '../server/settings.js'
import { compressBytes, compressStream } from './_codec.js'
import { isCompressible, selectEncoding } from './negotiate.js'

/** A content coding the server compresses with or decodes (RFC 9110 §8.4.1). */
export type ContentCoding = 'zstd' | 'br' | 'gzip' | 'deflate'

/** One `compression()`'s settings, or what a route's `compress({...})` sets over them, member by member. */
export interface CompressionConfig {
  /** The codings offered, in the order the server prefers them. Default `['zstd', 'br', 'gzip', 'deflate']`. */
  encodings?: readonly ContentCoding[]
  /**
   * The smallest body compressed when its size is known, such as `1 * KiB`, the default. A stream of unknown size is
   * always compressed.
   */
  threshold?: ByteSize
  /** gzip's level, 1 to 9; default 6. */
  gzip?: { level?: number }
  /** deflate's level, 1 to 9; default 6. */
  deflate?: { level?: number }
  /** Brotli's quality, 0 to 11; default 4. */
  br?: { quality?: number }
  /** zstd's level, 1 to 19; default 3. Above 19 the window would pass the 8 MiB a client must accept (RFC 9659). */
  zstd?: { level?: number }
  /** Whether a `Content-Type` is worth compressing; default {@link isCompressible}. */
  compressible?: (type: string) => boolean
}

/** The route config key `compress()` writes: {@link CompressionConfig} or a boolean. */
const kCompressionRoute = 'caffeine:compression'

export const kBuild: unique symbol = Symbol('caffeine.http.compression.build')

/** What `_codec.ts` compresses with, every member set. */
export interface ResolvedCodecs {
  readonly gzip: { readonly level: number }
  readonly deflate: { readonly level: number }
  readonly br: { readonly quality: number }
  readonly zstd: { readonly level: number }
}

/**
 * Authors one `compression()`'s settings. The callback runs while the factory builds the plugin, handed the same
 * `HTTPSetupContext` the factory gets, so a setting can come from the configuration.
 *
 * A list method adds to its list; called with nothing, it sets the list empty. What a fluent method sets replaces the
 * same member of what {@link CompressionBuilder.config} handed over.
 */
export class CompressionBuilder {
  #config: CompressionConfig | undefined
  // What the fluent methods set, each member replacing the same member of `#config`.
  readonly #set: {
    -readonly [K in keyof CompressionConfig]: CompressionConfig[K] extends readonly ContentCoding[] | undefined
      ? ContentCoding[]
      : CompressionConfig[K]
  } = {}

  /** Reads the settings from a node of the configuration tree, e.g. `config.app.compression`, once. */
  config(config: CompressionConfig): this {
    this.#config = config
    return this
  }

  /** The codings offered, in the order the server prefers them. */
  encodings(...encodings: ContentCoding[]): this {
    ;(this.#set.encodings ??= []).push(...encodings)
    return this
  }

  /** The smallest body compressed when its size is known, such as `1 * KiB`. */
  threshold(threshold: ByteSize): this {
    this.#set.threshold = threshold
    return this
  }

  /** gzip's settings: `{ level }`, 1 to 9. */
  gzip(options: { level?: number }): this {
    this.#set.gzip = options
    return this
  }

  /** deflate's settings: `{ level }`, 1 to 9. */
  deflate(options: { level?: number }): this {
    this.#set.deflate = options
    return this
  }

  /** Brotli's settings: `{ quality }`, 0 to 11. */
  br(options: { quality?: number }): this {
    this.#set.br = options
    return this
  }

  /** zstd's settings: `{ level }`, 1 to 19. */
  zstd(options: { level?: number }): this {
    this.#set.zstd = options
    return this
  }

  /** Whether a `Content-Type` is worth compressing, in place of {@link isCompressible}. */
  compressible(fn: (type: string) => boolean): this {
    this.#set.compressible = fn
    return this
  }

  [kBuild](): CompressionConfig {
    return overlay(this.#config ?? {}, this.#set)
  }
}

/**
 * HTTP compression: `.with(compression())`, imported from `@caffeinejs/http/compress`.
 *
 * It compresses an answer in the coding the client prefers among those offered (RFC 9110 §12.5.3). An answer is
 * compressed when its `Content-Type` is compressible and its size, when known, is at least the threshold; it then
 * varies on `Accept-Encoding`, whichever coding goes out. An answer that is already coded, a 206, or one that says
 * `Cache-Control: no-transform` goes out as it is. A compressed answer's strong `ETag` is sent weak, and its
 * `Accept-Ranges`, `Content-Digest`, `Repr-Digest` and `Content-MD5` are dropped: they describe the identity bytes.
 * No acceptable coding, `identity;q=0` included, sends identity rather than a 406, since the handler has run.
 *
 * Its hooks run on each route after the server's, the scopes', the group's and the route's own, and after the hooks
 * that plugins in outer slots, or registered before it in its slot, add to the route. So it compresses what
 * `HTTPCaching` stores only when caching is registered before it in the same slot, or in an outer one. Only the
 * routes of its slot are covered: a 404 for a path no route matches is not compressed. With several over one route, a
 * server's, a router's and a controller's, the innermost one alone compresses it, by its own settings and the route's
 * `compress(...)`.
 *
 * Compressing a secret beside input the request reflects lets an attacker who sees the sizes guess the secret
 * (BREACH): turn such a route off with `compress(false)`.
 *
 * @throws ErrConfiguration at start-up for a setting that is not one, an unknown or repeated coding, an empty
 * `encodings`, a threshold that is not a size, a level out of its range, and a route's `compress(...)` that is
 * neither an object nor a boolean.
 */
export function compression<C = unknown>(
  configure?: HTTPPluginConfigurer<CompressionBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new CompressionBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written.
    return new CompressionPlugin(builder[kBuild]())
  }
}

/**
 * Sets a route's compression, or every route's of a group, over `compression()`'s, member by member: `false` turns
 * it off for the route, `true` keeps the plugin's settings. The programmatic form of `@Compress(...)`.
 */
export function compress(options: CompressionConfig | boolean): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(kCompressionRoute, options)
  }
}

/** Every coding, in the order the server prefers them by default. */
export const CODINGS: readonly ContentCoding[] = ['zstd', 'br', 'gzip', 'deflate']
const DEFAULT_THRESHOLD: ByteSize = 1 * KiB
/** What `compression()` and a route's `compress({...})` may set. */
const SETTINGS: ReadonlySet<string> = new Set([
  'encodings',
  'threshold',
  'gzip',
  'deflate',
  'br',
  'zstd',
  'compressible',
])

/** Each coding's one setting: its name, its range and its default. */
const CODEC_SETTINGS = {
  gzip: { member: 'level', min: 1, max: 9, fallback: 6 },
  deflate: { member: 'level', min: 1, max: 9, fallback: 6 },
  br: { member: 'quality', min: 0, max: 11, fallback: 4 },
  zstd: { member: 'level', min: 1, max: 19, fallback: 3 },
} as const

/** One policy, as an answer is judged by it. */
interface ResolvedCompression {
  readonly encodings: readonly ContentCoding[]
  readonly threshold: ByteSize
  readonly codecs: ResolvedCodecs
  readonly compressible: (type: string) => boolean
}

// The `compression()` that owns each route: the innermost over it, whose `onRoute` runs last. Keyed by the definition,
// one per route and server.
const OWNERS = new WeakMap<RouteDefinition, CompressionPlugin>()

class CompressionPlugin extends HTTPPlugin {
  override readonly name = 'caffeine-compression'
  // What a route's `compress({...})` is written over.
  readonly #options: CompressionConfig
  readonly #own: ResolvedCompression

  constructor(config: CompressionConfig) {
    super()
    this.#own = resolve(config, 'build compression()', false)
    this.#options = config
  }

  register(context: HTTPSetupContext): void {
    const own = this.#own
    const options = this.#options

    context.app.hook('onRoute', route => {
      OWNERS.set(route, this)
      const where = `serve "${route.methods.join('|')} ${route.url}"`

      const policy = routePolicy(route.config.get(kCompressionRoute), own, options, where)
      if (policy !== undefined) {
        route.hook('onSend', (ctx, payload) => (OWNERS.get(route) === this ? encode(ctx, payload, policy) : undefined))
      }
    })
  }
}

// What a route's `compress(...)` makes of the plugin's policy: `undefined` for off.
function routePolicy(
  value: unknown,
  own: ResolvedCompression,
  options: CompressionConfig,
  where: string,
): ResolvedCompression | undefined {
  if (value === undefined || value === true) {
    return own
  }

  if (value === false) {
    return undefined
  }

  if (!isOptions(value)) {
    throw refusal(
      where,
      'its compression setting must be an object or a boolean',
      'Write "compress({ ... })" or "compress(false)"',
    )
  }

  return resolve(overlay(options, value), where, true)
}

/**
 * Compresses the answer when it is eligible and the client accepts a coding offered. `undefined` keeps the payload.
 */
function encode(
  ctx: IContext,
  payload: SendPayload,
  policy: ResolvedCompression,
): SendPayload | undefined | Promise<SendPayload> {
  const status = ctx.statusCode

  // A 304 carries no body, so it reaches here with none: it says what its 200 would have, by type when it has one.
  // Its tag is sent weak to a client that holds it weak, one a compressed 200 gave it, or that names no tag.
  if (status === 304) {
    if (eligible(ctx, policy, true)) {
      varyOnCoding(ctx)
      if (isCoding(selectEncoding(ctx.req.header('accept-encoding'), policy.encodings)) && heldWeak(ctx)) {
        weakenETag(ctx)
      }
    }
    return undefined
  }

  // Bodies the engine never sends: no content (204, 205) and a range of identity bytes (206).
  if (
    payload === null ||
    status === 204 ||
    status === 205 ||
    status === 206 ||
    ctx.getHeader('content-range') !== undefined ||
    !eligible(ctx, policy, false) ||
    belowThreshold(ctx, payload, policy.threshold)
  ) {
    return undefined
  }

  varyOnCoding(ctx)

  const coding = selectEncoding(ctx.req.header('accept-encoding'), policy.encodings)
  if (!isCoding(coding)) {
    return undefined
  }

  // Read before the coding replaces the body: a stream that declared its length is a whole, not a feed.
  const sized = ctx.getHeader('content-length') !== undefined
  ctx.header('content-encoding', coding)
  weakenETag(ctx)
  // What describes the identity bytes no longer holds: their ranges, and their digests (RFC 9530, RFC 1864).
  for (const name of IDENTITY_ONLY) {
    ctx.removeHeader(name)
  }

  if (ctx.req.method === 'HEAD') {
    // The engine drops what goes out and cancels only that: the handler's own stream is closed here.
    if (payload instanceof ReadableStream) {
      payload.cancel().catch(() => undefined)
    }

    // A stream has no length, so the head carries none rather than the identity body's.
    return new ReadableStream<Uint8Array>({ start: controller => controller.close() })
  }

  if (typeof payload === 'string') {
    return compressBytes(coding, ENCODER.encode(payload), policy.codecs)
  }

  return payload instanceof Uint8Array
    ? compressBytes(coding, payload, policy.codecs)
    : compressStream(coding, payload, policy.codecs, !sized)
}

const ACCEPT_ENCODING: readonly string[] = ['Accept-Encoding']

const IDENTITY_ONLY: readonly string[] = ['accept-ranges', 'content-digest', 'repr-digest', 'content-md5']

const ENCODER = new TextEncoder()

function isCoding(selected: ContentCoding | 'identity' | undefined): selected is ContentCoding {
  return selected !== undefined && selected !== 'identity'
}

// RFC 9110 §8.8.1: one tag for two codings is two representations under one strong validator.
function weakenETag(ctx: IContext): void {
  const etag = ctx.getHeader('etag')
  if (etag !== undefined && etag.startsWith('"')) {
    ctx.header('etag', `W/${etag}`)
  }
}

/**
 * Whether a client whose `If-None-Match` matched the answer's strong tag holds it weak: one a compressed 200 gave it.
 * The list is read as `If-Match` reads it, by strong comparison (RFC 9110 §8.8.3.2), which only the strong tag passes.
 * A client that names no tag, revalidating by date, is sent the tag the 200 it would get carries.
 */
function heldWeak(ctx: IContext): boolean {
  const etag = ctx.getHeader('etag')
  if (etag === undefined || !etag.startsWith('"')) {
    return false
  }

  const held = ctx.req.header('if-none-match')
  return held === undefined || preconditionFailed(held, undefined, { etag })
}

/**
 * Whether the head lets the answer be compressed: no coding of its own, no `no-transform`, and a compressible type;
 * `untyped` says what an answer with no `Content-Type` is, as a 304 carries none.
 */
function eligible(ctx: IContext, policy: ResolvedCompression, untyped: boolean): boolean {
  const coded = ctx.getHeader('content-encoding')
  if (
    (coded !== undefined && coded.trim().toLowerCase() !== 'identity') ||
    noTransform(ctx.getHeader('cache-control'))
  ) {
    return false
  }

  const type = ctx.getHeader('content-type')
  return type === undefined ? untyped : policy.compressible(type)
}

// RFC 9110 §12.5.5: the coding was chosen by `Accept-Encoding`.
function varyOnCoding(ctx: IContext): void {
  if (ctx.getHeader('vary') === undefined) {
    ctx.header('vary', 'Accept-Encoding')
  } else {
    appendVary(ctx, ACCEPT_ENCODING)
  }
}

// RFC 9111 §5.2.2.6: a directive, matched as a token, without regard to case.
function noTransform(cacheControl: string | undefined): boolean {
  return (
    cacheControl !== undefined &&
    cacheControl.split(',').some(directive => directive.split('=', 1)[0]!.trim().toLowerCase() === 'no-transform')
  )
}

/**
 * Whether the body is known to be under `threshold`. Text is bounded by its length before it is measured: its UTF-8
 * bytes are at least its length and at most three times it. A stream is measured by the length it declares.
 */
function belowThreshold(
  ctx: IContext,
  payload: string | Uint8Array | ReadableStream<Uint8Array>,
  threshold: ByteSize,
): boolean {
  if (typeof payload === 'string') {
    if (payload.length >= threshold) {
      return false
    }
    return payload.length * 3 < threshold || Buffer.byteLength(payload) < threshold
  }

  if (payload instanceof Uint8Array) {
    return payload.byteLength < threshold
  }

  const declared = ctx.getHeader('content-length')
  const length = declared === undefined ? Number.NaN : Number(declared)
  return Number.isInteger(length) && length >= 0 && length < threshold
}

/** `base` with every member of `over` that is not `undefined` written over it. */
export function overlay<T extends object>(base: T, over: object): T {
  return { ...base, ...Object.fromEntries(Object.entries(over).filter(([, value]) => value !== undefined)) }
}

/**
 * Checks `config` and reads it into a policy.
 *
 * @throws ErrConfiguration naming `where`, as `build compression()` or `serve "GET /x"`.
 */
function resolve(config: CompressionConfig, where: string, route: boolean): ResolvedCompression {
  for (const key of Object.keys(config)) {
    if (!SETTINGS.has(key)) {
      throw refusal(where, `"${key}" is not a compression setting`, `Use ${[...SETTINGS].join(', ')}`)
    }
  }

  const encodings = config.encodings === undefined ? CODINGS : codingsOf(config.encodings, 'encodings', where)
  if (encodings.length === 0) {
    throw refusal(
      where,
      '"encodings" lists no coding',
      ...(route
        ? ['Write compress(false) to turn compression off for the route']
        : ["List at least one coding, such as encodings: ['gzip']", 'Remove compression() to compress nothing']),
    )
  }

  const threshold = config.threshold ?? DEFAULT_THRESHOLD
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw refusal(where, '"threshold" must be a size in bytes', 'Write a size, such as 1 * KiB')
  }

  const compressible = config.compressible ?? isCompressible
  if (typeof compressible !== 'function') {
    throw refusal(
      where,
      '"compressible" must be a function of the content type',
      `Write "compressible: type => type.startsWith('text/')"`,
    )
  }

  return {
    encodings,
    threshold,
    compressible,
    codecs: {
      gzip: { level: codecSetting(config, 'gzip', where) },
      deflate: { level: codecSetting(config, 'deflate', where) },
      br: { quality: codecSetting(config, 'br', where) },
      zstd: { level: codecSetting(config, 'zstd', where) },
    },
  }
}

// One coding's setting, checked against its range, or its default.
function codecSetting(config: CompressionConfig, coding: keyof typeof CODEC_SETTINGS, where: string): number {
  const { member, min, max, fallback } = CODEC_SETTINGS[coding]
  const given: unknown = config[coding]
  if (given === undefined) {
    return fallback
  }

  if (!isOptions(given) || Object.keys(given).some(key => key !== member)) {
    throw refusal(where, `"${coding}" takes { ${member} } alone`, `Write "${coding}: { ${member}: ${fallback} }"`)
  }

  const value = (given as Record<string, unknown>)[member]
  if (value === undefined) {
    return fallback
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw refusal(
      where,
      `"${coding}.${member}" must be a whole number from ${min} to ${max}`,
      `Write a ${member} from ${min} to ${max}, such as ${fallback}`,
    )
  }

  return value
}

/** A list of codings, each known and listed once. */
export function codingsOf(value: unknown, key: string, where: string): readonly ContentCoding[] {
  if (!Array.isArray(value)) {
    throw refusal(where, `"${key}" must be a list of codings`, `Write "${key}: ['gzip', 'br']"`)
  }

  const seen = new Set<string>()
  for (const coding of value) {
    if (typeof coding !== 'string' || !CODINGS.includes(coding as ContentCoding)) {
      throw refusal(where, `"${String(coding)}" is not a content coding`, 'Use zstd, br, gzip or deflate')
    }

    if (seen.has(coding)) {
      throw refusal(where, `"${coding}" is listed twice in "${key}"`, 'List each coding once')
    }
    seen.add(coding)
  }

  return value as ContentCoding[]
}

export function refusal(where: string, reason: string, ...solutions: string[]): ErrConfiguration {
  return configurationError(`Cannot ${where}: ${reason}`, ...solutions)
}
