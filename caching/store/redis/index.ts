import { parseDuration, type Duration } from '@caffeinejs/std'
import { RESP_TYPES } from '@redis/client'

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
