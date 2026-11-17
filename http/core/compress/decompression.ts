import type { ByteSize } from '@caffeinejs/std/bytes'

import type { IContext } from '../../context.js'
import { HTTPPlugin, type HTTPPluginConfigurer, type HTTPPluginFactory, type HTTPSetupContext } from '../../plugin.js'
import { ErrHTTPUnsupportedMediaType } from '../error/http.js'
import type { RouteDefinition } from '../lifecycle/route_definition.js'
import type { AnyRouteExtension } from '../routing/extension.js'
import { BODY_METHODS } from '../server/body.js'
import { kDecodeBody, type BodyDecoder, type Context } from '../server/context.js'
import { isOptions } from '../server/settings.js'
import { decompressBytes, decompressStream } from './_codec.js'
import { CODINGS, codingsOf, kBuild, overlay, refusal, type ContentCoding } from './compress.js'
import { normalize } from './negotiate.js'

/** One `decompression()`'s settings. */
export interface DecompressionConfig {
  /** The request codings decoded; every {@link ContentCoding} by default. */
  encodings?: readonly ContentCoding[]
}

/** The route config key `decompress()` writes: `false`, or `{ codings }`. A method's list replaces its controller's. */
const kDecompressionRoute = 'caffeine:decompression'

/**
 * Authors one `decompression()`'s settings. The callback runs while the factory builds the plugin, handed the same
 * `HTTPSetupContext` the factory gets, so a setting can come from the configuration.
 *
 * What a fluent method sets replaces the same member of what {@link DecompressionBuilder.config} handed over.
 */
export class DecompressionBuilder {
  #config: DecompressionConfig | undefined
  readonly #set: { encodings?: ContentCoding[] } = {}

  /** Reads the settings from a node of the configuration tree, e.g. `config.app.decompression`, once. */
  config(config: DecompressionConfig): this {
    this.#config = config
    return this
  }

  /** The request codings decoded. Each call adds to the list; called with nothing, it sets the list empty. */
  encodings(...encodings: ContentCoding[]): this {
    ;(this.#set.encodings ??= []).push(...encodings)
    return this
  }

  [kBuild](): DecompressionConfig {
    return overlay(this.#config ?? {}, this.#set)
  }
}

/**
 * HTTP request decompression: `.with(decompression())`, imported from `@caffeinejs/http/compress`.
 *
 * It decodes a request body sent with a `Content-Encoding`, for the methods that carry one, in one coding, held to the
 * route's `bodyLimit` on the decoded bytes. Another coding, or more than one, is a 415 that lists in `Accept-Encoding`
 * what the route decodes; bytes that are not the coding they claim are a 400. The request keeps its `Content-Encoding`
 * and `Content-Length` headers, and `ctx.req.raw` is the request as received. On a route that decodes nothing, a coded
 * body reaches the parser as it is.
 *
 * Only the routes of its slot are covered. With several over one route, a server's, a router's and a controller's, the
 * innermost one alone decodes it, by its own codings and the route's `decompress(...)`.
 *
 * @throws ErrConfiguration at start-up for a setting that is not one, an unknown or repeated coding, an empty list of
 * codings, and a route's `decompress(...)` that lists none.
 */
export function decompression<C = unknown>(
  configure?: HTTPPluginConfigurer<DecompressionBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new DecompressionBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written.
    return new DecompressionPlugin(builder[kBuild]())
  }
}

/**
 * The request codings a route decodes, or every route's of a group, in place of `decompression()`'s; `false` decodes
 * none. The programmatic form of `@Decompress(...)`.
 */
export function decompress(encodings: ContentCoding | readonly ContentCoding[] | false): AnyRouteExtension {
  const value = encodings === false ? false : { codings: typeof encodings === 'string' ? [encodings] : encodings }

  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(kDecompressionRoute, value)
  }
}

// The `decompression()` that owns each route: the innermost over it, whose `onRoute` runs last. Keyed by the
// definition, one per route and server.
const OWNERS = new WeakMap<RouteDefinition, DecompressionPlugin>()

class DecompressionPlugin extends HTTPPlugin {
  override readonly name = 'caffeine-decompression'
  readonly #codings: readonly ContentCoding[]

  constructor(config: DecompressionConfig) {
    super()
    const where = 'build decompression()'
    for (const key of Object.keys(config)) {
      if (key !== 'encodings') {
        throw refusal(where, `"${key}" is not a decompression setting`, 'Use encodings')
      }
    }

    const codings = config.encodings === undefined ? CODINGS : codingsOf(config.encodings, 'encodings', where)
    if (codings.length === 0) {
      throw refusal(
        where,
        '"encodings" lists no coding',
        "List at least one coding, such as encodings: ['gzip']",
        'Remove decompression() to decode nothing',
      )
    }
    this.#codings = codings
  }

  register(context: HTTPSetupContext): void {
    const own = this.#codings

    context.app.hook('onRoute', route => {
      OWNERS.set(route, this)
      const where = `serve "${route.methods.join('|')} ${route.url}"`

      const decoding = route.config.get(kDecompressionRoute)
      const codings = decoding === undefined ? own : routeCodings(decoding, where)
      // A route that takes no body never decodes one.
      if (codings.length > 0 && route.methods.some(method => BODY_METHODS.has(method))) {
        route.hook('onRequest', ctx => (OWNERS.get(route) === this ? decodeRequest(ctx, codings) : undefined))
      }
    })
  }
}

// What a route's `decompress(...)` decodes.
function routeCodings(value: unknown, where: string): readonly ContentCoding[] {
  if (value === false) {
    return []
  }

  const listed = isOptions(value) ? (value as { codings?: unknown }).codings : undefined
  if (!Array.isArray(listed)) {
    throw refusal(
      where,
      '"decompress" must be a list of codings',
      "Write decompress(['gzip', 'br']) or decompress(false)",
    )
  }

  const codings = codingsOf(listed, 'decompress', where)
  if (codings.length === 0) {
    throw refusal(where, '"decompress" lists no coding', 'Write decompress(false) to decode nothing on the route')
  }
  return codings
}

/** Sets a decoder for a coded request body, or refuses a coding the route does not decode with a 415. */
function decodeRequest(ctx: IContext, codings: readonly ContentCoding[]): void {
  const req = (ctx as unknown as Context).req
  if (!BODY_METHODS.has(req.method)) {
    return
  }

  const header = req.header('content-encoding')
  if (header === undefined) {
    return
  }

  let coding: string | undefined
  let more = false
  for (const entry of header.split(',')) {
    const token = normalize(entry.trim().toLowerCase())
    if (token === '' || token === 'identity') {
      continue
    }
    more ||= coding !== undefined
    coding ??= token
  }

  if (coding === undefined) {
    return
  }

  if (more || !codings.includes(coding as ContentCoding)) {
    throw new ErrHTTPUnsupportedMediaType(
      `The request body is encoded as "${header}", which this route does not decode`,
      { headers: { 'accept-encoding': codings.join(', ') } },
    )
  }

  req[kDecodeBody] = DECODERS[coding as ContentCoding]
}

/** One decoder per coding, shared by every request: each call builds its own coder. */
const DECODERS: Readonly<Record<ContentCoding, BodyDecoder>> = Object.fromEntries(
  CODINGS.map(coding => [
    coding,
    {
      bytes: (encoded: Uint8Array, limit: ByteSize) => decompressBytes(coding, encoded, limit),
      stream: (encoded: ReadableStream<Uint8Array>) => decompressStream(coding, encoded),
    },
  ]),
) as Record<ContentCoding, BodyDecoder>
