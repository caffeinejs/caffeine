import { parseDuration, type Duration } from '@caffeinejs/std'
import { RESP_TYPES } from '@redis/client'

import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../../http/store.js'
import type { Cache, CacheEntry, CachePutItem } from '../../store.js'

/** Thrown for a {@link RedisCache} that is set up, or called, in a way it cannot serve. */
export class ErrRedisCache extends Error {
  readonly code = 'ERR_REDIS_CACHE'

  constructor(message: string) {
    super(message)
    this.name = 'ErrRedisCache'
  }
}

/** The commands {@link RedisCache} sends. Every one of them names a single key. */
export interface RedisCacheCommands {
  get(key: string): Promise<unknown>
  hmGet(key: string, fields: string[]): Promise<unknown>
  hSetEx(
    key: string,
    fields: Record<string, string | Buffer>,
    options: { expiration: { type: 'PX'; value: number } },
  ): Promise<unknown>
  unlink(key: string): Promise<unknown>
  incr(key: string): Promise<unknown>
}

/**
 * The part of a node-redis client this store calls. A client from `createClient()` and one from
 * `createCluster()` both satisfy it, imported from `@redis/client` or from `redis`, which re-exports it.
 */
export interface RedisCacheClient {
  withTypeMapping(typeMapping: { [RESP_TYPES.BLOB_STRING]: typeof Buffer }): RedisCacheCommands
}

export interface RedisCacheOptions {
  /** Prepended to every key this store writes. Defaults to `caffeine:cache:`. May not hold `{` or `}`. */
  prefix?: string
  /**
   * The cluster hash tag for a segment's keys. There is none by default, so the keys of a segment spread over the
   * cluster one by one. Return a tag to keep a segment on one shard, the same tag for several segments to keep
   * them together, or `undefined` for none. A tag may not hold `{` or `}`.
   */
  hashTag?: (segment: string) => string | undefined
}

const DEFAULT_PREFIX = 'caffeine:cache:'

// p the payload, as the bytes it was given · m everything else about the entry, as JSON. Both are written on
// every put: HSETEX leaves a field it does not name in place, so an entry made of a fixed set of fields can
// never inherit one from the entry it replaces.
const FIELDS = ['p', 'm']

// s status code · k payload kind (s string, b Buffer) · h headers · t etag · l last-modified · a stored at ·
// g the segment generation the entry was written under.
interface Meta {
  s: number
  k: 's' | 'b'
  h: CacheEntry['headers']
  t?: string
  l?: string
  a?: number
  g?: string
}

/**
 * A {@link Cache} on one Redis or Valkey server, or on a cluster of them.
 *
 * The client is the caller's, from `createClient()` or `createCluster()`: it is expected connected, and this
 * store never connects, closes, or reconnects it.
 *
 * Needs Redis 8.0 or Valkey 9.0: an entry is written with `HSETEX`, and an older server rejects every write.
 *
 * An entry is one hash, its payload stored as the bytes it was given. `clear(segment)` is a single `INCR` on the
 * segment's generation counter, whatever the segment holds: an entry written under an earlier generation reads
 * as absent, and is overwritten by the next `put` under its key or removed by its `ttl`. `clear()` without a
 * segment is refused — nothing short of walking the keyspace could serve it, and this store never does.
 *
 * No command names more than one key, so a cluster client needs nothing more: a batch is sent as single-key
 * commands in one go, and keys spread over the cluster unless {@link RedisCacheOptions.hashTag} gathers them.
 *
 * Counters have no `ttl`. Under an `allkeys-*` eviction policy the server may evict one, which restarts the
 * segment's generation: an entry written under a number that comes round again is readable until its own `ttl`.
 * Run the server with `noeviction` or a `volatile-*` policy.
 *
 * @throws ErrRedisCache When `prefix` holds a brace.
 */
export class RedisCache implements Cache {
  readonly #commands: RedisCacheCommands
  readonly #prefix: string
  readonly #hashTag: (segment: string) => string | undefined

  constructor(client: RedisCacheClient, options?: RedisCacheOptions) {
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX
    this.#hashTag = options?.hashTag ?? noTag

    // Redis hashes the first `{...}` of a key, so a brace ahead of the tag would take its place.
    if (hasBrace(this.#prefix)) {
      throw new ErrRedisCache(`Cannot create a Redis cache with the prefix "${this.#prefix}": it holds a brace`)
    }

    // One view whose bulk replies are Buffers, so a payload comes back as the bytes that went in.
    this.#commands = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
  }

  async get(key: string, segment?: string): Promise<CacheEntry | undefined> {
    if (!segment) {
      return decode(await this.#commands.hmGet(this.#entryKey(key), FIELDS), undefined)
    }

    const root = this.#root(segment)
    const [generation, fields] = await Promise.all([
      this.#commands.get(counterKey(root, segment)),
      this.#commands.hmGet(entryKey(root, segment, key), FIELDS),
    ])

    return decode(fields, text(generation) ?? '0')
  }

  async getMany(keys: string[], segment?: string): Promise<(CacheEntry | undefined)[]> {
    if (keys.length === 0) {
      return []
    }

    // Single-key commands issued together: one pipeline on a server, one fan-out over the nodes of a cluster.
    // Awaited as one, so a command that rejects after another did is never left without a handler.
    const root = segment ? this.#root(segment) : this.#prefix
    const [generation, replies] = await Promise.all([
      segment ? this.#commands.get(counterKey(root, segment)) : undefined,
      Promise.all(keys.map(key => this.#commands.hmGet(entryKey(root, segment, key), FIELDS))),
    ])
    const current = segment ? (text(generation) ?? '0') : undefined

    return replies.map(fields => decode(fields, current))
  }

  async put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void> {
    await this.putMany([{ key, entry, ttl }], segment)
  }

  async putMany(items: CachePutItem[], segment?: string): Promise<void> {
    const writes = items.flatMap(item => {
      const ms = Math.ceil(parseDuration(item.ttl) * 1000)

      return ms > 0 && Number.isFinite(ms) ? [{ ...item, ms }] : []
    })
    if (writes.length === 0) {
      return
    }

    // Read once for the batch. A `clear` landing between this and a write leaves an entry under the earlier
    // generation, which reads as absent.
    const root = segment ? this.#root(segment) : this.#prefix
    const generation = segment ? (text(await this.#commands.get(counterKey(root, segment))) ?? '0') : undefined

    await Promise.all(
      writes.map(({ key, entry, ms }) =>
        this.#commands.hSetEx(
          entryKey(root, segment, key),
          { p: entry.payload, m: JSON.stringify(metaOf(entry, generation)) },
          { expiration: { type: 'PX', value: ms } },
        ),
      ),
    )
  }

  async delete(key: string, segment?: string): Promise<void> {
    await this.#commands.unlink(entryKey(segment ? this.#root(segment) : this.#prefix, segment, key))
  }

  async deleteMany(keys: string[], segment?: string): Promise<void> {
    const root = segment ? this.#root(segment) : this.#prefix

    // One UNLINK for each key rather than one for all: keys without a segment fall in different slots.
    await Promise.all(keys.map(key => this.#commands.unlink(entryKey(root, segment, key))))
  }

  /** @throws ErrRedisCache Without a segment. */
  async clear(segment?: string): Promise<void> {
    if (!segment) {
      throw new ErrRedisCache(
        'Cannot clear a Redis cache without a segment: it would take a walk of the keyspace, which this store never does',
      )
    }

    await this.#commands.incr(counterKey(this.#root(segment), segment))
  }

  #entryKey(key: string): string {
    return entryKey(this.#prefix, undefined, key)
  }

  // The prefix every key of `segment` starts with, hash tag included.
  #root(segment: string): string {
    const tag = this.#hashTag(segment)
    if (tag === undefined || tag === '') {
      return this.#prefix
    }

    if (hasBrace(tag)) {
      throw new ErrRedisCache(`Cannot use the hash tag "${tag}" for segment "${segment}": it holds a brace`)
    }

    return `${this.#prefix}{${tag}}:`
  }
}

// `e:` entries and `g:` counters. `l:` is kept free for per-key locks beside the entries they guard.
// The segment is length-prefixed, so no segment is a prefix of another and an unsegmented key cannot read as a
// segmented one.
function entryKey(root: string, segment: string | undefined, key: string): string {
  return segment ? `${root}e:${segment.length}:${segment}${key}` : `${root}e:0:${key}`
}

function counterKey(root: string, segment: string): string {
  return `${root}g:${segment}`
}

function noTag(): undefined {
  return undefined
}

function hasBrace(value: string): boolean {
  return value.includes('{') || value.includes('}')
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return Buffer.isBuffer(value) ? value.toString() : String(value)
}

function metaOf(entry: CacheEntry, generation: string | undefined): Meta {
  return {
    s: entry.statusCode,
    k: Buffer.isBuffer(entry.payload) ? 'b' : 's',
    h: entry.headers,
    t: entry.etag,
    l: entry.lastModified,
    a: entry.storedAt,
    g: generation,
  }
}

// `generation` is the segment's current one, `undefined` for an entry without a segment.
function decode(reply: unknown, generation: string | undefined): CacheEntry | undefined {
  const [payload, fields] = reply as (Buffer | null)[]

  if (payload === null || payload === undefined || fields === null || fields === undefined) {
    return undefined
  }

  const meta = JSON.parse(fields.toString()) as Meta
  if (meta.g !== generation) {
    return undefined
  }

  const entry: CacheEntry = {
    payload: meta.k === 'b' ? payload : payload.toString(),
    statusCode: meta.s,
    headers: meta.h,
  }

  if (meta.t !== undefined) {
    entry.etag = meta.t
  }
  if (meta.l !== undefined) {
    entry.lastModified = meta.l
  }
  if (meta.a !== undefined) {
    entry.storedAt = meta.a
  }

  return entry
}

type BufferMapping = { [RESP_TYPES.BLOB_STRING]: typeof Buffer }

// One view whose bulk replies are Buffers, so a payload comes back as the bytes that went in.
const BUFFER_MAPPING: BufferMapping = { [RESP_TYPES.BLOB_STRING]: Buffer }

/** The commands {@link RedisHTTPCacheStore} sends. Every one of them names a single key. */
export interface RedisHTTPCacheCommands {
  get(key: string): Promise<unknown>
  hmGet(key: string, fields: string[]): Promise<unknown>
  hSetEx(
    key: string,
    fields: Record<string, string | Buffer>,
    options: { expiration: { type: 'PX'; value: number } },
  ): Promise<unknown>
  incr(key: string): Promise<unknown>
}

/** What `withTypeMapping` hands back: the commands, and on a single-server client a way to bind a signal to them. */
export interface RedisHTTPCacheView extends RedisHTTPCacheCommands {
  withAbortSignal?(signal: AbortSignal): RedisHTTPCacheCommands
}

/**
 * The part of a node-redis client this store calls. A client from `createClient()` and one from
 * `createCluster()` both satisfy it, imported from `@redis/client` or from `redis`, which re-exports it.
 *
 * A call with a signal binds it through `withAbortSignal` where the client has it, which keeps the client's own
 * command options. A cluster client has no `withAbortSignal`, so the signal goes through `withCommandOptions`,
 * which replaces those options: on a cluster, a call with a signal runs without the client's default command
 * timeout, and the signal is its only bound.
 */
export interface RedisHTTPCacheClient {
  withTypeMapping(typeMapping: BufferMapping): RedisHTTPCacheView
  withCommandOptions(options: { typeMapping: BufferMapping; abortSignal: AbortSignal }): RedisHTTPCacheCommands
}

export interface RedisHTTPCacheStoreOptions {
  /**
   * Put in front of every key this store writes, as given: no separator is added. Defaults to `caffeine:cache:`;
   * `''` puts nothing in front. May not hold `{` or `}`.
   */
  prefix?: string
}

// s status code · k payload kind (s string, b Buffer) · h headers · t etag · l last-modified · a stored at ·
// g the generation of each tag the entry was written under.
interface HTTPMeta {
  s: number
  k: 's' | 'b'
  h: HTTPCacheEntry['headers']
  t?: string
  l?: string
  a?: number
  g?: Record<string, string>
}

/**
 * An {@link HTTPCacheStore} on one Redis or Valkey server, or on a cluster of them.
 *
 * The client is the caller's, from `createClient()` or `createCluster()`: it is expected connected, and this
 * store never connects, closes, or reconnects it.
 *
 * Needs Redis 8.0 or Valkey 9.0: an entry is written with `HSETEX`, and an older server rejects every write.
 *
 * An entry is one hash, its payload stored as the bytes it was given. A tag is a counter: an entry records the
 * counter of each of its tags when it is stored, and reads as absent once one of them has moved on.
 * `evictByTag` is one `INCR` per tag, whatever the tags cover; the entry itself goes when it is next overwritten
 * or expires. No command names more than one key, and nothing walks the keyspace, so a cluster client needs
 * nothing more: a call's commands are sent together and spread over the cluster.
 *
 * Counters have no `ttl`. Under an `allkeys-*` eviction policy the server may evict one, which restarts the
 * tag's count: an entry written under a number that comes round again is readable until its own `ttl`. Run the
 * server with `noeviction` or a `volatile-*` policy.
 *
 * @throws ErrRedisCache When `prefix` holds a brace.
 */
export class RedisHTTPCacheStore implements HTTPCacheStore {
  readonly #client: RedisHTTPCacheClient
  readonly #view: RedisHTTPCacheView
  readonly #prefix: string

  constructor(client: RedisHTTPCacheClient, options?: RedisHTTPCacheStoreOptions) {
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX

    // Redis hashes the first `{...}` of a key, so a brace would decide the slot.
    if (hasBrace(this.#prefix)) {
      throw new ErrRedisCache(`Cannot create a Redis cache with the prefix "${this.#prefix}": it holds a brace`)
    }

    this.#client = client
    this.#view = client.withTypeMapping(BUFFER_MAPPING)
  }

  // The entry and the counters of the hinted tags are read together. Only a tag the entry carries that the hint
  // did not name costs a second batch.
  async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    options?.signal?.throwIfAborted()

    // Every key is derived before a command goes out, so a tag that is refused sends nothing.
    const hinted = options?.tags ?? []
    const hintedKeys = hinted.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options?.signal)
    const [fields, ...counters] = await Promise.all([
      commands.hmGet(this.#entryKey(key), FIELDS),
      ...hintedKeys.map(tagKey => commands.get(tagKey)),
    ])

    const [payload, meta] = fields as (Buffer | null)[]
    if (payload === null || payload === undefined || meta === null || meta === undefined) {
      return undefined
    }

    const parsed = JSON.parse(meta.toString()) as HTTPMeta
    const recorded = parsed.g
    if (recorded !== undefined) {
      const current = new Map<string, string>()
      hinted.forEach((tag, i) => current.set(tag, text(counters[i]) ?? '0'))

      const unhinted = Object.keys(recorded).filter(tag => !current.has(tag))
      if (unhinted.length > 0) {
        const unhintedKeys = unhinted.map(tag => this.#tagKey(tag))
        const more = await Promise.all(unhintedKeys.map(tagKey => commands.get(tagKey)))
        unhinted.forEach((tag, i) => current.set(tag, text(more[i]) ?? '0'))
      }

      for (const tag in recorded) {
        if (recorded[tag] !== current.get(tag)) {
          return undefined
        }
      }
    }

    return decodeEntry(payload, parsed)
  }

  async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    options.signal?.throwIfAborted()

    const ms = Math.ceil(parseDuration(options.ttl) * 1000)
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const tags = options.tags ?? []
    const tagKeys = tags.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options.signal)

    // Read together, once for the call. An eviction landing between this and the write leaves an entry under the
    // earlier count, which reads as absent.
    let generations: Record<string, string> | undefined
    if (tags.length > 0) {
      const counters = await Promise.all(tagKeys.map(tagKey => commands.get(tagKey)))
      generations = {}
      tags.forEach((tag, i) => (generations![tag] = text(counters[i]) ?? '0'))
    }

    // Both fields on every put: HSETEX leaves a field it does not name in place, so an entry made of a fixed set
    // of fields can never inherit one from the entry it replaces.
    await commands.hSetEx(
      this.#entryKey(key),
      { p: entry.payload, m: JSON.stringify(httpMetaOf(entry, generations)) },
      { expiration: { type: 'PX', value: ms } },
    )
  }

  async evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    options?.signal?.throwIfAborted()

    const list = typeof tags === 'string' ? [tags] : tags
    if (list.length === 0) {
      return
    }

    const tagKeys = list.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options?.signal)
    await Promise.all(tagKeys.map(tagKey => commands.incr(tagKey)))
  }

  #commands(signal: AbortSignal | undefined): RedisHTTPCacheCommands {
    if (signal === undefined) {
      return this.#view
    }

    return this.#view.withAbortSignal
      ? this.#view.withAbortSignal(signal)
      : this.#client.withCommandOptions({ typeMapping: BUFFER_MAPPING, abortSignal: signal })
  }

  // `e:` entries and `t:` tag counters. `l:` is kept free for per-key locks beside the entries they guard.
  #entryKey(key: string): string {
    return `${this.#prefix}e:${key}`
  }

  #tagKey(tag: string): string {
    if (hasBrace(tag)) {
      throw new ErrRedisCache(`Cannot use the tag "${tag}" on a Redis cache: it holds a brace`)
    }

    return `${this.#prefix}t:${tag}`
  }
}

function httpMetaOf(entry: HTTPCacheEntry, generations: Record<string, string> | undefined): HTTPMeta {
  return {
    s: entry.statusCode,
    k: Buffer.isBuffer(entry.payload) ? 'b' : 's',
    h: entry.headers,
    t: entry.etag,
    l: entry.lastModified,
    a: entry.storedAt,
    g: generations,
  }
}

function decodeEntry(payload: Buffer, meta: HTTPMeta): HTTPCacheEntry {
  const entry: HTTPCacheEntry = {
    payload: meta.k === 'b' ? payload : payload.toString(),
    statusCode: meta.s,
    headers: meta.h,
  }

  if (meta.t !== undefined) {
    entry.etag = meta.t
  }
  if (meta.l !== undefined) {
    entry.lastModified = meta.l
  }
  if (meta.a !== undefined) {
    entry.storedAt = meta.a
  }

  return entry
}
