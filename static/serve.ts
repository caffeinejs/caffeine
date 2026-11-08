import { constants, createReadStream, lstatSync, open as openCallback, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { Readable } from 'node:stream'

import {
  ErrHTTPInternalServerError,
  ErrHTTPNotAcceptable,
  ErrHTTPPreconditionFailed,
  appendVary,
  byteRanges,
  notModified,
  preconditionFailed,
  rangeHolds,
  type Validators,
  type VaryReply,
} from '@caffeinejs/http'
import { KiB } from '@caffeinejs/std/bytes'

import {
  ErrStaticManifest,
  REBUILD_SOLUTIONS,
  type Encoding,
  type ManifestFile,
  type ManifestVariant,
} from './manifest/manifest.js'
import { selectEncoding } from './negotiate.js'

/** What a mount decides about every file it serves, computed once when the mount is built. */
export interface FilePolicy {
  /** `Cache-Control` written on the mount's routes. */
  readonly routeCacheControl: (path: string) => string
  /** `Cache-Control` written by `sendFile`, which cannot see the gate of the route that called it. */
  readonly sendFileCacheControl: (path: string) => string
  /** Extra headers for one file, already checked. */
  readonly headers: (path: string, file: ManifestFile) => Readonly<Record<string, string>> | undefined
}

/** A mount's root as start-up checks files against it: as given, resolved, and each directory resolved once. */
export interface RootOnDisk {
  /** As `.serve(...)` resolved it, for messages. */
  readonly root: string
  /** Its real path, with every symlink on the way resolved. */
  readonly real: string
  /** Real paths of the directories already resolved under it. */
  readonly directories: Map<string, string>
}

/** One representation of a file, its headers computed once. */
export interface Representation {
  readonly encoding: Encoding | 'identity'
  /** Absolute path of the bytes on disk. */
  readonly path: string
  readonly size: number
  readonly validators: Validators
  /** What a `200` carries, but `Cache-Control`. */
  readonly headers: Readonly<Record<string, string>>
  /** What a `304` carries, but `Cache-Control`. */
  readonly notModified: Readonly<Record<string, string>>
}

/** A manifest entry made ready to answer requests: every representation, and the variants smallest first. */
export interface PreparedFile {
  /** The manifest key. */
  readonly path: string
  readonly identity: Representation
  readonly variants: readonly Representation[]
  /** The variants' codings, smallest first, as negotiation takes them. */
  readonly encodings: readonly Encoding[]
  readonly cacheControl: { readonly route: string; readonly sendFile: string }
}

/** The part of a request {@link serveFile} reads. */
export interface FileRequest {
  readonly method: string
  header(name: string): string | undefined
}

/** Where a failure to open a file is logged. */
export interface FileLog {
  error(fields: object, message: string): void
}

/** The answer {@link serveFile} decided on: written as status, headers, `Cache-Control`, then the body. */
export interface FileDecision {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** Absent on a `416`, which carries `Content-Range` alone. */
  readonly cacheControl: string | undefined
  /** The open file, or nothing for a `HEAD`, a `304` or a `416`. */
  readonly body: Readable | undefined
}

/** How a decision is asked for. */
export interface ServeOptions {
  /** Whose `Cache-Control` to write. */
  readonly via: 'route' | 'sendFile'
  /** Whether preconditions and ranges apply: a `GET` or a `HEAD` answering in place of a `200`. */
  readonly conditional: boolean
  readonly log: FileLog
}

/** The stream buffer, so a slow reader holds one file descriptor and this much memory. */
const HIGH_WATER_MARK = 64 * KiB

// Not every platform defines it; where it does, a symlink swapped in after start-up is refused at open.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

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
  const variants = (Object.entries(entry.variants) as Array<[Encoding, ManifestVariant]>).toSorted(
    ([, a], [, b]) => a.size - b.size,
  )
  const lastModified = new Date(entry.lastModified)
  const hasVariants = variants.length > 0
  const extra = policy.headers(path, entry)

  const representation = (
    encoding: Encoding | 'identity',
    file: string,
    size: number,
    hash: string,
  ): Representation => {
    const absolute = checked(disk, file, size)
    const validators = { etag: `"${hash}"`, lastModified }
    const headers: Record<string, string> = {
      'content-type': entry.type,
      'content-length': String(size),
      etag: validators.etag,
      'last-modified': lastModified.toUTCString(),
      'x-content-type-options': 'nosniff',
    }

    if (encoding === 'identity') {
      headers['accept-ranges'] = 'bytes'
    } else {
      headers['content-encoding'] = encoding
    }

    Object.assign(headers, extra)
    delete headers.vary
    varyOf(headers, extra?.vary, hasVariants)

    const notModifiedHeaders: Record<string, string> = {
      etag: headers.etag!,
      'last-modified': headers['last-modified']!,
    }
    if (headers.vary !== undefined) {
      notModifiedHeaders.vary = headers.vary
    }

    return {
      encoding,
      path: absolute,
      size,
      validators,
      headers: Object.freeze(headers),
      notModified: Object.freeze(notModifiedHeaders),
    }
  }

  const identity = representation('identity', path, entry.size, entry.hash)
  const prepared = variants.map(([encoding, variant]) =>
    representation(encoding, variant.path, variant.size, variant.hash),
  )

  return {
    path,
    identity,
    variants: prepared,
    encodings: variants.map(([encoding]) => encoding),
    cacheControl: { route: policy.routeCacheControl(path), sendFile: policy.sendFileCacheControl(path) },
  }
}

/**
 * Decides the answer to a request for `file`: negotiate the coding, check the preconditions on the representation
 * chosen, take a range of the identity, then open the file. Nothing is written here; the caller writes the decision.
 *
 * A request carrying `Range` gets identity, so offsets mean what the client thinks, unless the client refuses
 * identity, when the range is ignored. One range is a `206`, a range past the end a `416`, and anything else the
 * whole `200`.
 *
 * @throws {@link ErrHTTPNotAcceptable} when the client accepts no representation
 * @throws {@link ErrHTTPPreconditionFailed} when `If-Match` or `If-Unmodified-Since` no longer holds
 * @throws {@link ErrHTTPInternalServerError} when the file cannot be opened, which is logged
 */
export async function serveFile(
  file: PreparedFile,
  request: FileRequest,
  options: ServeOptions,
): Promise<FileDecision> {
  const cacheControl = options.via === 'route' ? file.cacheControl.route : file.cacheControl.sendFile
  const range = options.conditional && request.method === 'GET' ? request.header('range') : undefined
  const acceptEncoding = request.header('accept-encoding')

  // A range is of the identity's bytes: taken when the client accepts identity, ignored when it does not.
  const ranged = range !== undefined && selectEncoding(acceptEncoding, []) === 'identity'
  const selected = ranged ? file.identity : representationFor(file, acceptEncoding)

  if (options.conditional) {
    if (preconditionFailed(request.header('if-match'), request.header('if-unmodified-since'), selected.validators)) {
      throw new ErrHTTPPreconditionFailed()
    }

    if (notModified(request.header('if-none-match'), request.header('if-modified-since'), selected.validators)) {
      return { status: 304, headers: selected.notModified, cacheControl, body: undefined }
    }
  }

  if (request.method === 'HEAD') {
    return { status: 200, headers: selected.headers, cacheControl, body: undefined }
  }

  if (ranged && rangeHolds(request.header('if-range'), selected.validators)) {
    const ranges = byteRanges(range, selected.size)

    if (ranges === 'unsatisfiable') {
      return {
        status: 416,
        headers: { 'content-range': `bytes */${selected.size}` },
        cacheControl: undefined,
        body: undefined,
      }
    }

    // Several ranges are served whole: RFC 9110 §14.2 lets a server ignore Range, and clients ask for one.
    if (ranges !== undefined && ranges.length === 1) {
      const [[start, end]] = ranges as [readonly [number, number]]
      const headers = {
        ...selected.headers,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${selected.size}`,
      }

      return { status: 206, headers, cacheControl, body: await openFile(selected, options.log, start, end) }
    }
  }

  return { status: 200, headers: selected.headers, cacheControl, body: await openFile(selected, options.log) }
}

/**
 * Writes a decision's headers on a reply. `Vary` is merged with what is already there, which a CORS plugin or the
 * handler may have written: replacing it would let a shared cache answer one `Origin` with another's response.
 */
export function writeHeaders(reply: VaryReply, headers: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(headers)) {
    if (name === 'vary') {
      appendVary(
        reply,
        headers.vary!.split(',').map(name => name.trim()),
      )
    } else {
      reply.header(name, headers[name]!)
    }
  }
}

function representationFor(file: PreparedFile, acceptEncoding: string | undefined): Representation {
  const encoding = selectEncoding(acceptEncoding, file.encodings)

  if (encoding === undefined) {
    throw new ErrHTTPNotAcceptable()
  }

  return encoding === 'identity' ? file.identity : file.variants[file.encodings.indexOf(encoding)]!
}

async function openFile(
  representation: Representation,
  log: FileLog,
  start = 0,
  // The last byte, always given: without it the stream reads once more to find the end, a read syscall per response.
  end = Math.max(representation.size - 1, 0),
): Promise<Readable> {
  let fd: number

  try {
    fd = await openDescriptor(representation.path)
  } catch (err) {
    // The manifest says the file is there, so the deployment changed under a running server.
    log.error({ err, path: representation.path }, 'Cannot open a static file the manifest lists')
    throw new ErrHTTPInternalServerError()
  }

  // A descriptor rather than a `FileHandle`: its stream reads with callbacks, not a promise per chunk. It closes the
  // descriptor when it ends or is destroyed, which Fastify does when the client goes away.
  return createReadStream('', { fd, start, end, highWaterMark: HIGH_WATER_MARK })
}

function openDescriptor(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    openCallback(path, constants.O_RDONLY | O_NOFOLLOW, (err, fd) => (err === null ? resolve(fd) : reject(err)))
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

/** Writes `Vary` into `headers`: what `headers(file)` asked for, merged with `Accept-Encoding` for a file with variants. */
function varyOf(headers: Record<string, string>, given: string | undefined, hasVariants: boolean): void {
  const reply = {
    getHeader: (name: string) => headers[name],
    header: (name: string, value: string) => {
      headers[name] = value
    },
  }

  if (given !== undefined) {
    appendVary(reply, given.split(','))
  }

  if (hasVariants) {
    appendVary(reply, ['Accept-Encoding'])
  }
}
