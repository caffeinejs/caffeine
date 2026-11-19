import { MiB, type ByteSize } from '@caffeinejs/std/bytes'

import { createSHA256 } from '#static-sha256'

import {
  ErrStaticManifest,
  MANIFEST_FILE,
  assertStoredHash,
  parseManifest,
  type Encoding,
  type ManifestFile,
  type ManifestVariant,
} from '../manifest/manifest.js'

/**
 * Raw bytes of one immutable release. Every open returns a fresh, unlocked stream with bounded chunks.
 * A source releases its resources on EOF, error or cancellation and honors an abort during acquisition and reading.
 */
export interface StaticAssetSource {
  readManifest(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>
  /** Read the stored representation, including its original compression, over the entire key or the exact range. */
  open(
    key: string,
    options: {
      readonly signal?: AbortSignal
      readonly range?: { readonly start: number; readonly endExclusive: number }
    },
  ): Promise<ReadableStream<Uint8Array>>
}

export interface VerifyStaticAssetsOptions {
  readonly signal?: AbortSignal
  /** Maximum size of the UTF-8 manifest. Default 8 MiB. */
  readonly maxManifestSize?: ByteSize
  /** Maximum number of identity keys, excluding their variants. Default 20,000. */
  readonly maxEntries?: number
}

export interface VerifiedStaticAssets {
  readonly files: number
  /** Counted per identity, including each reference to a shared variant. */
  readonly variants: number
  /** Total stored bytes verified across all identities and their listed variants. */
  readonly bytes: ByteSize
  /** Whether the manifest lists this exact identity key. */
  has(key: string): boolean
}

const SOURCE = 'static asset source'

/**
 * Verify every stored identity and compressed variant before returning the release's membership and counts.
 * Reads one representation at a time. Aborting rejects with the signal's reason.
 *
 * @throws {@link ErrStaticManifest} if a limit, manifest, stored length or digest is invalid, or a read fails.
 */
export function verifyStaticAssets(
  source: StaticAssetSource,
  options: VerifyStaticAssetsOptions = {},
): Promise<VerifiedStaticAssets> {
  return verifyAssets(source, options)
}

type CheckVariant = (
  chunks: AsyncIterable<Uint8Array>,
  identity: ManifestFile,
  encoding: Encoding,
  variant: ManifestVariant,
) => Promise<void>

/** Build preflight can also check the decoded identity as it consumes the verified variant chunks. */
export async function verifyAssets(
  source: StaticAssetSource,
  { signal, maxManifestSize = 8 * MiB, maxEntries = 20_000 }: VerifyStaticAssetsOptions,
  checkVariant?: CheckVariant,
): Promise<VerifiedStaticAssets> {
  signal?.throwIfAborted()

  for (const [option, limit] of Object.entries({ maxManifestSize, maxEntries })) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new ErrStaticManifest(
        SOURCE,
        `"${option}" must be a non-negative safe integer`,
        `Set "${option}" to a non-negative safe integer`,
      )
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let size = 0
  let text = ''

  await readSource(
    MANIFEST_FILE,
    () => source.readManifest(signal),
    signal,
    async reader => {
      for (;;) {
        const chunk = await reader.read()
        signal?.throwIfAborted()

        if (!chunk.done) {
          size += chunk.value.byteLength

          if (size > maxManifestSize) {
            throw new ErrStaticManifest(
              SOURCE,
              `"${MANIFEST_FILE}" exceeds "maxManifestSize" of ${maxManifestSize} bytes`,
              'Raise "maxManifestSize" if you trust the manifest',
            )
          }
        }

        try {
          text += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
        } catch {
          throw new ErrStaticManifest(
            SOURCE,
            `"${MANIFEST_FILE}" is not valid UTF-8`,
            `Regenerate "${MANIFEST_FILE}" as UTF-8`,
          )
        }

        if (chunk.done) {
          return
        }
      }
    },
  )

  const manifest = parseManifest(text, SOURCE, maxEntries)
  const keys = new Set(Object.keys(manifest.files))
  let variants = 0
  let bytes = 0

  for (const key of keys) {
    const file = manifest.files[key]!
    await verifyObject(source, key, file, signal)
    bytes += file.size

    for (const [encoding, variant] of Object.entries(file.variants)) {
      await verifyObject(
        source,
        variant.path,
        variant,
        signal,
        checkVariant && (chunks => checkVariant(chunks, file, encoding as Encoding, variant)),
      )
      variants++
      bytes += variant.size
    }
  }

  signal?.throwIfAborted()
  return { files: keys.size, variants, bytes, has: key => keys.has(key) }
}

async function verifyObject(
  source: StaticAssetSource,
  key: string,
  expected: Pick<ManifestVariant, 'hash' | 'size'>,
  signal?: AbortSignal,
  consume?: (chunks: AsyncIterable<Uint8Array>) => Promise<void>,
): Promise<void> {
  await readSource(
    key,
    () => source.open(key, { signal }),
    signal,
    async reader => {
      const hash = createSHA256()
      let size = 0
      let verified = false

      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (;;) {
          const chunk = await reader.read()
          signal?.throwIfAborted()

          if (chunk.done) {
            break
          }

          size += chunk.value.byteLength

          if (size > expected.size) {
            throw new ErrStaticManifest(
              SOURCE,
              `"${key}" exceeds its declared size of ${expected.size} bytes`,
              `Restore "${key}" from the build output`,
            )
          }

          hash.update(chunk.value)
          yield chunk.value
        }

        if (size !== expected.size) {
          throw new ErrStaticManifest(
            SOURCE,
            `"${key}" has ${size} bytes, the manifest declares ${expected.size} bytes`,
            `Restore "${key}" from the build output`,
          )
        }

        assertStoredHash(SOURCE, key, btoa(String.fromCharCode(...hash.digest())), expected.hash)
        verified = true
      }

      if (consume) {
        await consume(chunks())
      } else {
        for await (const _chunk of chunks()) {
          // Reading through EOF verifies both the length and the digest.
        }
      }

      if (!verified) {
        throw new ErrStaticManifest(SOURCE, `"${key}" was not consumed to its end`, 'Read the variant stream to EOF')
      }
    },
  )
}

async function readSource(
  key: string,
  open: () => Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal | undefined,
  consume: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cancelled: Promise<void> | undefined

  function cancel(reason: unknown): void {
    // Abort and a read failure can coincide. Keep the first reason and cancel only once.
    if (reader) {
      cancelled ??= reader.cancel(reason).catch(() => undefined)
    }
  }

  async function read(): Promise<void> {
    const stream = await open()
    reader = stream.getReader()

    try {
      // A provider may resolve its open after the caller has already aborted.
      signal?.throwIfAborted()
      await consume(reader)
      signal?.throwIfAborted()
    } catch (err) {
      cancel(err)
      throw err
    } finally {
      reader.releaseLock()
      if (cancelled && !signal?.aborted) {
        await cancelled
      }
    }
  }

  const stopped = signal && Promise.withResolvers<never>()
  const onAbort = () => {
    cancel(signal!.reason)
    stopped!.reject(signal!.reason)
  }

  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (stopped) {
      await Promise.race([read(), stopped.promise])
    } else {
      await read()
    }
  } catch (err) {
    signal?.throwIfAborted()

    if (err instanceof ErrStaticManifest) {
      throw err
    }
    throw new ErrStaticManifest(SOURCE, `"${key}" cannot be read`, `Make "${key}" readable in the source`)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
