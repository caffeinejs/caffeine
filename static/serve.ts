import { constants, createReadStream, lstatSync, open as openCallback, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { Readable } from 'node:stream'

import { ErrHTTPInternalServerError } from '@caffeinejs/http'
import { KiB } from '@caffeinejs/std/bytes'

import {
  assertStoredHash,
  ErrStaticManifest,
  REBUILD_SOLUTIONS,
  type Encoding,
  type ManifestFile,
} from './manifest/manifest.js'
import {
  prepareResponseFile,
  type FileLog,
  type Representation,
  type FilePolicy,
  type PreparedFile,
} from './response/index.js'
import { hashFile } from './scan/scan.js'

/** A mount's root as start-up checks files against it: as given, resolved, and each directory resolved once. */
export interface RootOnDisk {
  /** As `.serve(...)` resolved it, for messages. */
  readonly root: string
  /** Its real path, with every symlink on the way resolved. */
  readonly real: string
  /** Real paths of the directories already resolved under it. */
  readonly directories: Map<string, string>
}

/** The stream buffer, so a slow reader holds one file descriptor and this much memory. */
const HIGH_WATER_MARK = 64 * KiB

/** `root` as {@link prepareFile} checks files against it. */
export function rootOnDisk(root: string): RootOnDisk {
  return { root, real: realpathSync(root), directories: new Map() }
}

/**
 * Checks one manifest entry against the disk and computes its headers: every representation is a regular file of
 * the size the manifest says, inside the root.
 *
 * Synchronous: it runs at start-up, before the server listens, where one `lstat` per file costs a fraction of what
 * the thread pool adds to an asynchronous one, and each directory is resolved once.
 *
 * @throws {@link ErrStaticManifest} naming the file that is missing, of another size, not a regular file, or outside
 * the root
 */
export function prepareFile(disk: RootOnDisk, path: string, entry: ManifestFile, policy: FilePolicy): PreparedFile {
  return prepareResponseFile(path, entry, policy, (key, size) => checked(disk, key, size))
}

export async function openFile(
  representation: Representation,
  { log, reqId }: { log: FileLog; reqId?: string },
  start = 0,
  // The last byte, always given: without it the stream reads once more to find the end, a read syscall per response.
  end = Math.max(representation.size - 1, 0),
): Promise<Readable> {
  let fd: number

  try {
    fd = await openDescriptor(representation.path)
  } catch (err) {
    // The manifest says the file is there, so the deployment changed under a running server.
    log.error({ err, path: representation.path, reqId }, 'Cannot open a static file the manifest lists')
    throw new ErrHTTPInternalServerError()
  }

  // A descriptor rather than a `FileHandle`: its stream reads with callbacks, not a promise per chunk. It closes the
  // descriptor when it ends or is destroyed, which the server does when the client goes away.
  return createReadStream('', { fd, start, end, highWaterMark: HIGH_WATER_MARK })
}

function openDescriptor(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // A symlink swapped in after start-up is refused at open. Where a platform has no `O_NOFOLLOW` it is undefined,
    // which `|` reads as 0.
    openCallback(path, constants.O_RDONLY | constants.O_NOFOLLOW, (err, fd) =>
      err === null ? resolve(fd) : reject(err),
    )
  })
}

/** Where `file` is, once it is known to be a regular file of `size` bytes whose directory resolves inside the root. */
function checked(disk: RootOnDisk, file: string, size: number): string {
  const { root, real } = disk
  const absolute = join(real, file)
  let stats

  try {
    stats = lstatSync(absolute)
  } catch {
    throw new ErrStaticManifest(root, `"${file}" is listed but missing`, ...REBUILD_SOLUTIONS)
  }

  // Not a symlink itself, so only a symlinked directory on the way could move it elsewhere.
  if (!stats.isFile()) {
    throw new ErrStaticManifest(
      root,
      `"${file}" is not a regular file`,
      'Replace it with the file itself',
      ...REBUILD_SOLUTIONS,
    )
  }

  const directory = dirname(absolute)
  let resolved = disk.directories.get(directory)

  if (resolved === undefined) {
    resolved = realpathSync(directory)
    disk.directories.set(directory, resolved)
  }

  if (resolved !== real && !resolved.startsWith(real + sep)) {
    throw new ErrStaticManifest(
      root,
      `"${file}" resolves outside the root`,
      'Replace the symlinked directory with the files themselves',
    )
  }

  if (stats.size !== size) {
    throw new ErrStaticManifest(
      root,
      `"${file}" is ${stats.size} bytes, and the manifest says ${size}`,
      ...REBUILD_SOLUTIONS,
    )
  }

  return absolute
}

/**
 * Hashes each representation of `file` and compares it with what the manifest says.
 *
 * {@link prepareFile} checks sizes alone, which bytes replaced at the same length pass. The ETag is the manifest's
 * hash, so such a file would be served under the tag of the bytes it replaced.
 *
 * @throws {@link ErrStaticManifest} naming the first file whose bytes changed after the build
 */
export async function verifyHashes(root: string, file: PreparedFile, entry: ManifestFile): Promise<void> {
  const expected = [
    { path: file.path, absolute: file.identity.path, hash: entry.hash },
    ...file.variants.map(({ encoding, path }) => {
      const variant = entry.variants[encoding as Encoding]!

      return { path: variant.path, absolute: path, hash: variant.hash }
    }),
  ]

  for (const { path, absolute, hash } of expected) {
    assertStoredHash(root, path, (await hashFile(absolute)).hash, hash)
  }
}
