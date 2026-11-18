import { KiB, MiB, type ByteSize } from '@caffeinejs/std/bytes'
import { errMessage } from '@caffeinejs/std/err'

import { DEFAULT_BODY_LIMIT, isBodyLimit } from '../server/body_limit.js'
import { ErrMultipart } from './error.js'

/** Resource limits for a finite multipart message. Routes may override individual server settings. */
export interface MultipartLimits {
  /** Payload bytes in one part, including a nested container. Defaults to the effective body limit. */
  maxPartSize?: ByteSize
  /** Payload bytes in one form field. Defaults to 64 KiB. */
  maxFieldSize?: ByteSize
  /** Aggregate payload bytes collected into one FormData, including file bodies. Defaults to 1 MiB. */
  maxBufferedSize?: ByteSize
  /** Wire bytes in one part's header block, the outer Content-Type or a delimiter line. Defaults to 16 KiB. */
  maxHeaderSize?: ByteSize
  /** Header field occurrences per part before folding. Defaults to 32. */
  maxHeaders?: number
  /** Parts in the whole document, including containers and descendants. Defaults to 256. */
  maxParts?: number
  /** Files in the form, including nested file groups. Defaults to 16. Zero disallows files. */
  maxFiles?: number
  /** Child levels below the root. Defaults to 4. Zero permits only the root; the ceiling is 16. */
  maxDepth?: number
}

export const MAX_MULTIPART_DEPTH = 16

const DEFAULTS: Readonly<Required<MultipartLimits>> = Object.freeze({
  maxPartSize: DEFAULT_BODY_LIMIT,
  maxFieldSize: 64 * KiB,
  maxBufferedSize: 1 * MiB,
  maxHeaderSize: 16 * KiB,
  maxHeaders: 32,
  maxParts: 256,
  maxFiles: 16,
  maxDepth: 4,
})

type FrameLimits = Pick<MultipartLimits, 'maxPartSize' | 'maxHeaderSize' | 'maxHeaders'>

const FRAME_DEFAULTS: Readonly<Required<FrameLimits>> = Object.freeze({
  maxPartSize: 8 * MiB,
  maxHeaderSize: DEFAULTS.maxHeaderSize,
  maxHeaders: DEFAULTS.maxHeaders,
})

/** Copies and validates declared settings, leaving omitted limits for the effective route to supply. */
export function snapshotMultipartLimits(limits: unknown): Readonly<MultipartLimits> {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new TypeError('Multipart limits must be an object of size and count limits')
  }

  const prototype: unknown = Object.getPrototypeOf(limits)
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new TypeError('Multipart limits must be a plain object')
  }

  const snapshot: MultipartLimits = {}
  for (const key of Reflect.ownKeys(limits)) {
    if (typeof key !== 'string' || !Object.hasOwn(DEFAULTS, key)) {
      throw new TypeError('Multipart limits contain an unknown option')
    }

    const name = key as keyof MultipartLimits
    const value: unknown = (limits as MultipartLimits)[name]
    if (value === undefined) {
      continue
    }

    const min = name === 'maxFiles' || name === 'maxDepth' ? 0 : 1
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      throw new TypeError(`Multipart limit "${name}" must be a safe integer of at least ${min}`)
    }
    if (name === 'maxDepth' && value > MAX_MULTIPART_DEPTH) {
      throw new TypeError(`Multipart limit "maxDepth" cannot exceed ${MAX_MULTIPART_DEPTH}`)
    }

    snapshot[name] = value
  }
  return Object.freeze(snapshot)
}

/** Resolves finite limits after the route's whole-body limit and inherited settings are known. */
export function resolveMultipartLimits(
  bodyLimit: ByteSize = DEFAULT_BODY_LIMIT,
  server?: MultipartLimits,
  route?: MultipartLimits,
): Readonly<Required<MultipartLimits>> {
  if (!isBodyLimit(bodyLimit)) {
    throw new TypeError('Multipart bodyLimit must be a positive safe integer of bytes')
  }

  return Object.freeze({
    ...DEFAULTS,
    maxPartSize: bodyLimit,
    ...(server === undefined ? undefined : snapshotMultipartLimits(server)),
    ...(route === undefined ? undefined : snapshotMultipartLimits(route)),
  })
}

/** Resolves the three per-frame limits applicable to an explicitly live replacement stream. */
export function resolveFrameLimits(limits?: FrameLimits): Readonly<Required<FrameLimits>> {
  if (limits === undefined) {
    return FRAME_DEFAULTS
  }
  const checked = snapshotMultipartLimits(limits)
  if (Reflect.ownKeys(limits).some(key => !Object.hasOwn(FRAME_DEFAULTS, key))) {
    throw new TypeError('Live multipart frames accept only maxPartSize, maxHeaderSize and maxHeaders')
  }
  return Object.freeze({ ...FRAME_DEFAULTS, ...checked })
}

/** Charges a nonnegative wire length or count before allocation or delivery. The sum stays exactly representable. */
export function chargeMultipartLimit(
  used: number,
  count: number,
  maximum: number,
  name: keyof MultipartLimits | 'bodyLimit',
): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('A multipart byte or occurrence count must be a nonnegative safe integer')
  }
  if (count > maximum - used) {
    throw new ErrMultipart(
      'limit',
      errMessage(`Cannot read multipart data: it exceeds "${name}"`)
        .reference('@caffeinejs/http', ErrMultipart)
        .build(),
    )
  }
  return used + count
}

/** One finite reader tree shares these counters. Only its outer source charges raw wire bytes. */
export class MultipartBudget {
  readonly #bodyLimit: ByteSize
  readonly #limits: Readonly<Required<MultipartLimits>>
  #wire = 0
  #parts = 0
  #files = 0

  constructor(bodyLimit: ByteSize, limits: Readonly<Required<MultipartLimits>>) {
    this.#bodyLimit = bodyLimit
    this.#limits = limits
  }

  chargeWire(bytes: ByteSize): void {
    this.#wire = chargeMultipartLimit(this.#wire, bytes, this.#bodyLimit, 'bodyLimit')
  }

  enterChild(depth: number): void {
    chargeMultipartLimit(0, depth, this.#limits.maxDepth, 'maxDepth')
  }

  takePart(): void {
    this.#parts = chargeMultipartLimit(this.#parts, 1, this.#limits.maxParts, 'maxParts')
  }

  takeFile(): void {
    this.#files = chargeMultipartLimit(this.#files, 1, this.#limits.maxFiles, 'maxFiles')
  }

  /** Starts the byte allowance of one FormData, including all nested files collected into it. */
  startCollector(): (bytes: ByteSize) => void {
    let buffered = 0
    return bytes => {
      buffered = chargeMultipartLimit(buffered, bytes, this.#limits.maxBufferedSize, 'maxBufferedSize')
    }
  }
}
