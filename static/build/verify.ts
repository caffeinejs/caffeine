import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip } from 'node:zlib'

import { directorySource } from '../directory/directory.js'
import { ErrStaticManifest, type Encoding, type ManifestFile, type ManifestVariant } from '../manifest/manifest.js'
import { verifyAssets, type VerifiedStaticAssets, type VerifyStaticAssetsOptions } from '../web/web.js'

export interface VerifyOptions extends VerifyStaticAssetsOptions {
  /** The completed release directory. Its contents must stay immutable while verification runs. */
  readonly root: string
}

/** Counts each manifest entry and its stored variants, even when entries share a variant file. */
export type VerifyReport = Pick<VerifiedStaticAssets, 'files' | 'variants' | 'bytes'>

/**
 * Verifies the manifest and all listed bytes of a staged directory without writing to it.
 * It also decodes each stored variant and checks the length and SHA-256 of its identity.
 *
 * @throws {@link ErrStaticManifest} when the release fails verification.
 */
export async function verifyStatic({ root, ...options }: VerifyOptions): Promise<VerifyReport> {
  options.signal?.throwIfAborted()
  const { files, variants, bytes } = await verifyAssets(
    directorySource(root),
    options,
    (chunks, identity, encoding, variant) => verifyDecoded(chunks, identity, encoding, variant, root, options.signal),
  )

  return { files, variants, bytes }
}

async function verifyDecoded(
  chunks: AsyncIterable<Uint8Array>,
  identity: ManifestFile,
  encoding: Encoding,
  variant: ManifestVariant,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const problem = (detail: string) =>
    new ErrStaticManifest(root, `"${variant.path}" ${detail}`, 'Rebuild the release with buildStatic({ root })')
  const hash = createHash('sha256')
  let size = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength

      if (size > identity.size) {
        callback(problem(`decodes to more than the identity's ${identity.size} bytes`))
        return
      }

      hash.update(chunk)
      callback()
    },
  })

  const decoder = encoding === 'br' ? createBrotliDecompress() : createGunzip()

  try {
    await pipeline(chunks, decoder, sink, { signal })
  } catch (err) {
    signal?.throwIfAborted()
    if (err instanceof ErrStaticManifest) {
      throw err
    }

    throw problem(`cannot be decoded as ${encoding}`)
  }

  if (decoder.bytesWritten !== variant.size) {
    throw problem(`contains trailing bytes after the ${encoding} representation`)
  }

  if (size !== identity.size || hash.digest('base64') !== identity.hash) {
    throw problem("does not decode to the identity's length and SHA-256")
  }
}
