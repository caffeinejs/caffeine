import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Hashes and verifies passwords.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. The credential module binds {@link ScryptPasswordHasher} as a fallback, so
 * `PasswordHasher` resolves out of the box; bind your own subclass (e.g. argon2) to override it.
 */
export abstract class PasswordHasher {
  /** Hash a plaintext password into a self-describing encoded string (salt + params embedded). */
  abstract hash(password: string): Promise<string>

  /** Verify a plaintext password against an encoded hash. Malformed input returns `false`, never throws. */
  abstract verify(password: string, encoded: string): Promise<boolean>

  /** Whether an encoded hash was produced with parameters weaker than this hasher's current settings. */
  abstract needsRehash(encoded: string): boolean
}

export interface ScryptParams {
  /** CPU/memory cost, a power of two. Default 2^15. */
  N: number
  /** Block size. Default 8. */
  r: number
  /** Parallelization. Default 1. */
  p: number
  /** Derived key length in bytes. Default 32. */
  keylen: number
}

const DEFAULT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1, keylen: 32 }
const SALT_BYTES = 16

/**
 * Default {@link PasswordHasher}, built on Node's `scrypt` — no external dependency.
 *
 * The encoded format is PHC-style and self-describing: `$scrypt$n=<N>,r=<r>,p=<p>$<saltB64>$<hashB64>`.
 * Because the parameters and salt travel with the hash, {@link verify} re-derives with the exact
 * settings the hash was created under, and {@link needsRehash} can detect stale ones. Comparison is
 * constant-time via `timingSafeEqual`.
 */
export class ScryptPasswordHasher extends PasswordHasher {
  readonly #params: ScryptParams

  constructor(params: Partial<ScryptParams> = {}) {
    super()
    this.#params = { ...DEFAULT_PARAMS, ...params }
  }

  async hash(password: string): Promise<string> {
    const { N, r, p } = this.#params
    const salt = randomBytes(SALT_BYTES)
    const derived = await this.#derive(password, salt, this.#params)
    return `$scrypt$n=${N},r=${r},p=${p}$${salt.toString('base64')}$${derived.toString('base64')}`
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = this.#parse(encoded)
    if (parsed === null) {
      return false
    }

    const { params, salt, hash } = parsed
    let derived: Buffer
    try {
      derived = await this.#derive(password, salt, params)
    } catch {
      return false
    }

    return derived.length === hash.length && timingSafeEqual(derived, hash)
  }

  needsRehash(encoded: string): boolean {
    const parsed = this.#parse(encoded)
    if (parsed === null) {
      return true
    }

    const { params } = parsed
    return params.N !== this.#params.N
      || params.r !== this.#params.r
      || params.p !== this.#params.p
      || params.keylen !== this.#params.keylen
  }

  #derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
    const { N, r, p, keylen } = params
    // scrypt needs roughly 128 * N * r bytes; the default maxmem (32 MiB) is too small for N=2^15,
    // so give it headroom rather than letting the call throw.
    const maxmem = 256 * N * r
    return new Promise((resolve, reject) => {
      scrypt(password, salt, keylen, { N, r, p, maxmem }, (err, dk) => {
        if (err) {
          reject(err)
        } else {
          resolve(dk)
        }
      })
    })
  }

  #parse(encoded: string): { params: ScryptParams, salt: Buffer, hash: Buffer } | null {
    // $scrypt$n=<N>,r=<r>,p=<p>$<saltB64>$<hashB64>
    const parts = encoded.split('$')
    if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'scrypt') {
      return null
    }

    const paramMatch = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2])
    if (paramMatch === null) {
      return null
    }

    const salt = Buffer.from(parts[3], 'base64')
    const hash = Buffer.from(parts[4], 'base64')
    if (salt.length === 0 || hash.length === 0) {
      return null
    }

    return {
      params: {
        N: Number(paramMatch[1]),
        r: Number(paramMatch[2]),
        p: Number(paramMatch[3]),
        keylen: hash.length,
      },
      salt,
      hash,
    }
  }
}
