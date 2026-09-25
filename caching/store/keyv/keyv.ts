import { randomUUID } from 'node:crypto'

import { parseDuration, type Duration } from '@caffeinejs/std/duration'

import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../../http/store.js'

const DEFAULT_PREFIX = 'caffeine:cache:'

// What an absent marker reads as. A marker this store writes is a UUID, so it can never be this.
const NEVER_EVICTED = '0'

/**
 * The part of a key-value cache this store calls. A cache-manager `Cache` and a `Keyv` both satisfy it.
 *
 * `ttl` is required, and in milliseconds: this store always decides how long what it writes is kept, so the
 * backend's own default `ttl` never applies to an entry or a marker. A backend whose `set` takes `ttl` optionally
 * still satisfies this.
 *
 * `get` hands back `unknown` rather than the string that was stored: `Keyv.get` is a set of overloads, and
 * pinning it to a concrete signature here is what breaks on an upstream release. The reply is coerced instead.
 */
export interface KeyValueHTTPCacheClient {
  get(key: string): Promise<unknown>
  set(key: string, value: string, ttl: number): Promise<unknown>
}

export interface KeyValueHTTPCacheStoreOptions {
  /**
   * Put in front of every key this store writes, as given: no separator is added. Defaults to `caffeine:cache:`;
   * `''` puts nothing in front.
   */
  prefix?: string
  /**
   * How long a tag marker is kept. Defaults to `0` — never expires, which is what the counters of the Redis and
   * memory stores do.
   *
   * Set it to bound the marker keyspace, and keep it above the longest `ttl` plus the longest stale window: a
   * marker that expires while an entry written under it is still alive takes that entry down with it, since the
   * marker it recorded no longer matches. That is over-eviction — a lost hit, never a stale response.
   */
  tagTtl?: Duration
}

// s status code · k payload kind (s string, b Buffer) · p the payload, base64 when it is bytes · h headers ·
// t etag · l last-modified · a stored at · g the marker of each tag the entry was written under.
interface HTTPEnvelope {
  s: number
  k: 's' | 'b'
  p: string
  h: HTTPCacheEntry['headers']
  t?: string
  l?: string
  a?: number
  g?: Record<string, string>
}

/**
 * An {@link HTTPCacheStore} on any key-value cache — a cache-manager `Cache`, a `Keyv`, or anything else
 * satisfying {@link KeyValueHTTPCacheClient}.
 *
 * The cache is the caller's: this store never creates, connects or disconnects it.
 *
 * An entry is one JSON string, written whole on every put, its payload base64 when it is bytes. What a backend
 * serializes is therefore always a string, which every Keyv adapter round-trips.
 *
 * A tag is a marker: an entry records the marker of each of its tags when it is stored, and reads as absent once
 * any of them has changed. `evictByTag` writes a fresh marker per tag and touches no entry; the entry goes when
 * it is next read, overwritten, or expired. Unlike a counter a marker cannot come round again.
 *
 * Neither cache-manager nor Keyv takes an `AbortSignal`. A call whose signal is already aborted is refused, but
 * one already issued runs to completion even after the cache has given up waiting for it.
 *
 * Both backends hide failures by default, which costs the cache its error reporting rather than its correctness:
 * cache-manager's `get` reads a broken store as a miss, and Keyv resolves instead of rejecting unless it was
 * built with `throwOnErrors: true`.
 */
export class KeyValueHTTPCacheStore implements HTTPCacheStore {
  readonly #client: KeyValueHTTPCacheClient
  readonly #prefix: string
  readonly #tagTtlMs: number

  constructor(client: KeyValueHTTPCacheClient, options?: KeyValueHTTPCacheStoreOptions) {
    this.#client = client
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX
    this.#tagTtlMs = tagTtlOf(options?.tagTtl)
  }

  // The entry and the markers of the hinted tags are read together. Only a tag the entry carries that the hint
  // did not name costs a second batch.
  async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    options?.signal?.throwIfAborted()

    const hinted = options?.tags ?? []
    const hintedKeys = hinted.map(tag => this.#tagKey(tag))
    const [raw, ...markers] = await Promise.all([
      this.#client.get(this.#entryKey(key)),
      ...hintedKeys.map(tagKey => this.#client.get(tagKey)),
    ])

    if (raw === null || raw === undefined) {
      return undefined
    }

    const envelope = JSON.parse(String(raw)) as HTTPEnvelope
    const recorded = envelope.g
    if (recorded !== undefined) {
      const current = new Map<string, string>()
      hinted.forEach((tag, i) => current.set(tag, marker(markers[i])))

      const unhinted = Object.keys(recorded).filter(tag => !current.has(tag))
      if (unhinted.length > 0) {
        const more = await Promise.all(unhinted.map(tag => this.#client.get(this.#tagKey(tag))))
        unhinted.forEach((tag, i) => current.set(tag, marker(more[i])))
      }

      for (const tag in recorded) {
        if (recorded[tag] !== current.get(tag)) {
          return undefined
        }
      }
    }

    return decodeEntry(envelope)
  }

  // A ttl of 0 means "never expires" to both backends, so a ttl that is not positive must not reach one — and
  // nothing is read for it either.
  async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    options.signal?.throwIfAborted()

    const ms = Math.ceil(parseDuration(options.ttl) * 1000)
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const tags = options.tags ?? []

    // Read together, once for the call. An eviction landing between this and the write leaves an entry under the
    // earlier marker, which reads as absent.
    let markers: Record<string, string> | undefined
    if (tags.length > 0) {
      const current = await Promise.all(tags.map(tag => this.#client.get(this.#tagKey(tag))))
      markers = {}
      tags.forEach((tag, i) => (markers![tag] = marker(current[i])))
    }

    await this.#client.set(this.#entryKey(key), JSON.stringify(envelopeOf(entry, markers)), ms)
  }

  async evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    options?.signal?.throwIfAborted()

    const list = typeof tags === 'string' ? [tags] : tags
    if (list.length === 0) {
      return
    }

    await Promise.all(list.map(tag => this.#client.set(this.#tagKey(tag), randomUUID(), this.#tagTtlMs)))
  }

  // `e:` entries and `t:` tag markers. Without the split an entry and a tag of the same name share a key.
  #entryKey(key: string): string {
    return `${this.#prefix}e:${key}`
  }

  #tagKey(tag: string): string {
    return `${this.#prefix}t:${tag}`
  }
}

function tagTtlOf(tagTtl: Duration | undefined): number {
  if (tagTtl === undefined) {
    return 0
  }

  const ms = Math.ceil(parseDuration(tagTtl) * 1000)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

function marker(value: unknown): string {
  return value === null || value === undefined ? NEVER_EVICTED : String(value)
}

function envelopeOf(entry: HTTPCacheEntry, markers: Record<string, string> | undefined): HTTPEnvelope {
  const bytes = Buffer.isBuffer(entry.payload)

  return {
    s: entry.statusCode,
    k: bytes ? 'b' : 's',
    p: bytes ? entry.payload.toString('base64') : (entry.payload as string),
    h: entry.headers,
    t: entry.etag,
    l: entry.lastModified,
    a: entry.storedAt,
    g: markers,
  }
}

function decodeEntry(envelope: HTTPEnvelope): HTTPCacheEntry {
  const entry: HTTPCacheEntry = {
    payload: envelope.k === 'b' ? Buffer.from(envelope.p, 'base64') : envelope.p,
    statusCode: envelope.s,
    headers: envelope.h,
  }

  if (envelope.t !== undefined) {
    entry.etag = envelope.t
  }
  if (envelope.l !== undefined) {
    entry.lastModified = envelope.l
  }
  if (envelope.a !== undefined) {
    entry.storedAt = envelope.a
  }

  return entry
}
