import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Durable, rotating, server-side-revocable credentials: the cookie scheme's remember-me and the bearer
// refresh-token grant. The `series` is an opaque lookup key; the `token` is the bearer secret, rotated on every use,
// and only its hash is ever stored.

/**
 * A rotating credential held server-side, addressed by its `series`.
 *
 * The token is never stored — only its hash — so a leaked store hands out nothing that still works.
 */
export interface SeriesTokenRecord {
  /** Opaque lookup key of this credential. */
  series: string
  /** The user's `sub`. The index {@link SeriesTokenStore.removeBySubject} revokes by. */
  subject: string
  /** `sha256` of the current token, base64url. Replaced on every use. */
  tokenHash: string
  /** When the credential stops being accepted if it is not used again, epoch seconds. Pushed back by every use. */
  expiresAt: number
  /**
   * When the series was first issued, epoch seconds.
   *
   * What an absolute lifetime is measured from. {@link expiresAt} moves every time the credential is used, so by
   * itself it lets a series that stays in use live forever.
   */
  createdAt: number
  /**
   * `sha256` of the token this series held before the most recent rotation.
   *
   * A superseded token normally means the token was stolen. But a browser sends requests in parallel, each one
   * carrying the cookie as it stood when the batch began, so the first response to rotate would turn its own
   * siblings into apparent thefts. A superseded token is therefore accepted, without rotating again, while
   * {@link rotatedAt} is within the grace window. Absent on a series that has never rotated.
   */
  previousTokenHash?: string
  /** When {@link previousTokenHash} was superseded, epoch seconds. */
  rotatedAt?: number
}

/** What one rotation writes. Grouped, not positional: four bare arguments invite transposition. */
export interface SeriesTokenRotation {
  tokenHash: string
  previousTokenHash: string
  rotatedAt: number
  expiresAt: number
}

/**
 * Persists rotating credentials so they outlive what they renew and can be revoked server-side.
 *
 * No production implementation ships with this package, deliberately: an in-process store is a footgun once there
 * is more than one instance. Supply one backed by whatever the deployment already shares — Redis, a database.
 */
export abstract class SeriesTokenStore {
  /** Persists a freshly minted series. */
  abstract create(record: SeriesTokenRecord): Promise<void> | void

  /** Looks a series up. `null` for an unknown or a revoked one. */
  abstract findBySeries(series: string): Promise<SeriesTokenRecord | null> | SeriesTokenRecord | null

  /**
   * Replaces the token of a series **only if its current hash is still `expectedTokenHash`**, and says whether it did.
   *
   * The comparison and the write have to be one atomic step — a conditional `UPDATE ... WHERE token_hash = ?`, a
   * Lua script, a transaction. Read-then-write is not enough: two requests presenting the same token would both
   * read it as current and both rotate, which spends one token twice. With the swap, exactly one of them wins, and
   * the other is told so.
   *
   * Every field of the rotation has to be persisted. `previousTokenHash` and `rotatedAt` are what tell a request
   * that lost the race apart from a replayed stolen token.
   *
   * @returns `false` when the series is gone or its token is no longer `expectedTokenHash`.
   */
  abstract rotate(series: string, expectedTokenHash: string, rotation: SeriesTokenRotation): Promise<boolean> | boolean

  /** Revokes one credential: a sign-out, or a detected replay. */
  abstract remove(series: string): Promise<void> | void

  /** Revokes every credential a user holds. Needs a secondary index keyed by subject. */
  abstract removeBySubject(subject: string): Promise<void> | void
}

export interface SeriesTokenPolicy {
  /** How long the credential stays acceptable after its last use, in seconds. */
  idleSeconds: number
  /** How long a series may live from the moment it was issued, however often it is used. Unset: no limit. */
  absoluteSeconds?: number
  /**
   * How long a just-superseded token stays acceptable, in seconds. `0` is strict single use: any superseded token
   * is a replay.
   */
  graceSeconds: number
}

/** Why a presented credential was refused. `replayed` is the one that means a copy of it is in someone else's hands. */
export type SeriesTokenRejection = 'malformed' | 'unknown' | 'expired' | 'replayed'

/** What {@link readSeriesToken} made of a presented credential. */
export type SeriesTokenReading =
  | { status: 'current'; record: SeriesTokenRecord }
  /** A token superseded moments ago by a request that raced this one. Good for this request; not to be rotated. */
  | { status: 'superseded'; record: SeriesTokenRecord }
  | { status: 'rejected'; reason: SeriesTokenRejection }

/**
 * Looks a presented `series:token` up and decides what it is, without changing it.
 *
 * An expired series and a replayed one are removed on the way: a replay means someone holds a copy of a credential
 * that was already spent, so the legitimate holder is made to sign in again too — that is the point of detecting it.
 *
 * Separate from {@link rotateSeriesToken} so the caller can do what may fail — reload the user, sign the new access
 * token — before the credential is spent.
 */
export async function readSeriesToken(
  store: SeriesTokenStore,
  presented: string,
  policy: SeriesTokenPolicy,
  now = nowSeconds(),
): Promise<SeriesTokenReading> {
  const parsed = parseToken(presented)
  if (parsed === null) {
    return { status: 'rejected', reason: 'malformed' }
  }

  const record = await store.findBySeries(parsed.series)
  if (record === null) {
    return { status: 'rejected', reason: 'unknown' }
  }

  if (isExpired(record, policy, now)) {
    await store.remove(record.series)
    return { status: 'rejected', reason: 'expired' }
  }

  if (tokenMatches(parsed.token, record.tokenHash)) {
    return { status: 'current', record }
  }

  if (withinGrace(parsed.token, record, policy, now)) {
    return { status: 'superseded', record }
  }

  await store.remove(record.series)
  return { status: 'rejected', reason: 'replayed' }
}

/** What {@link rotateSeriesToken} did with a current credential. */
export type SeriesTokenRotated =
  | { status: 'rotated'; token: string; record: SeriesTokenRecord }
  /** Another request rotated first, within the grace window. Good for this request; it has no new token to hand out. */
  | { status: 'superseded'; record: SeriesTokenRecord }
  | { status: 'rejected'; reason: 'replayed' }

/**
 * Spends a credential {@link readSeriesToken} found current: mints the next token and swaps it in.
 *
 * The swap is conditional on the token still being the one that was read. A request that loses it was raced by
 * another one presenting the same token: inside the grace window that is a sibling and it is let through without
 * a new token; outside it, the same token was spent twice, which is a replay.
 *
 * @param presented - The same `series:token` that was read.
 */
export async function rotateSeriesToken(
  store: SeriesTokenStore,
  presented: string,
  record: SeriesTokenRecord,
  policy: SeriesTokenPolicy,
  now = nowSeconds(),
): Promise<SeriesTokenRotated> {
  const next = newToken()
  const rotation: SeriesTokenRotation = {
    tokenHash: hashToken(next),
    previousTokenHash: record.tokenHash,
    rotatedAt: now,
    expiresAt: expiryAfter(record, policy, now),
  }

  if (await store.rotate(record.series, record.tokenHash, rotation)) {
    return { status: 'rotated', token: formatToken(record.series, next), record: { ...record, ...rotation } }
  }

  const parsed = parseToken(presented)
  const latest = await store.findBySeries(record.series)

  if (parsed !== null && latest !== null && withinGrace(parsed.token, latest, policy, now)) {
    return { status: 'superseded', record: latest }
  }

  await store.remove(record.series)
  return { status: 'rejected', reason: 'replayed' }
}

/** A freshly issued series for `subject`, and the `series:token` to hand to its holder. */
export function newSeriesToken(
  subject: string,
  policy: SeriesTokenPolicy,
  now = nowSeconds(),
): { record: SeriesTokenRecord; token: string } {
  const series = newSeries()
  const token = newToken()
  const record: SeriesTokenRecord = { series, subject, tokenHash: hashToken(token), createdAt: now, expiresAt: now }

  record.expiresAt = expiryAfter(record, policy, now)

  return { record, token: formatToken(series, token) }
}

/** The idle lifetime from now, cut short by the absolute one when the series has one. */
function expiryAfter(record: SeriesTokenRecord, policy: SeriesTokenPolicy, now: number): number {
  const idle = now + policy.idleSeconds

  return policy.absoluteSeconds === undefined ? idle : Math.min(idle, record.createdAt + policy.absoluteSeconds)
}

function isExpired(record: SeriesTokenRecord, policy: SeriesTokenPolicy, now: number): boolean {
  if (record.expiresAt <= now) {
    return true
  }

  // A record written before series carried their creation time has none to measure from.
  const createdAt = record.createdAt as number | undefined

  return policy.absoluteSeconds !== undefined && createdAt !== undefined && createdAt + policy.absoluteSeconds <= now
}

/**
 * Whether a superseded token is recent enough to be a raced request rather than a replay.
 *
 * Both halves must hold: the token has to match the hash this series most recently rotated away from, and that
 * rotation has to be inside the window. A store that does not persist the rotation fields fails this and falls
 * through to replay detection — the conservative direction.
 */
function withinGrace(token: string, record: SeriesTokenRecord, policy: SeriesTokenPolicy, now: number): boolean {
  // `0` is an off switch, not a zero-width window: time has second granularity, so `elapsed > 0` would still admit
  // a replay landing in the same second as the rotation it follows.
  if (policy.graceSeconds <= 0) {
    return false
  }

  if (record.previousTokenHash === undefined || record.rotatedAt === undefined) {
    return false
  }

  if (now - record.rotatedAt > policy.graceSeconds) {
    return false
  }

  return tokenMatches(token, record.previousTokenHash)
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Opaque series identifier: 128 bits is ample for a lookup key. */
export function newSeries(): string {
  return randomBytes(16).toString('base64url')
}

/** Bearer secret token: 256 bits. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a token for at-rest storage. A fast hash suffices — the token is high-entropy random. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token))
  const b = Buffer.from(storedHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Encode `series` and `token` into a single opaque string (`series:token`). */
export function formatToken(series: string, token: string): string {
  return `${series}:${token}`
}

/** Split a `series:token` string on the first colon. Returns null for malformed input. */
export function parseToken(value: string): { series: string; token: string } | null {
  const sep = value.indexOf(':')
  if (sep <= 0 || sep === value.length - 1) {
    return null
  }
  return { series: value.slice(0, sep), token: value.slice(sep + 1) }
}
