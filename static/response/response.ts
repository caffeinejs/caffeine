import { selectEncoding } from '@caffeinejs/http/compress/negotiate'
import { notModified, preconditionFailed, rangeHolds, type Validators } from '@caffeinejs/http/conditional'
import { byteRanges } from '@caffeinejs/http/range/parser'
import { appendVary, type VaryReply } from '@caffeinejs/http/vary'

import type { Encoding, ManifestFile, ManifestVariant } from '../manifest/manifest.js'

/** What a mount decides about every file it serves, computed once when the mount is built. */
export interface FilePolicy {
  /** `Cache-Control` written on the mount's routes. */
  readonly routeCacheControl: (path: string) => string
  /** `Cache-Control` written by `sendFile`, which cannot see the gate of the route that called it. */
  readonly sendFileCacheControl: (path: string) => string
  /** Extra headers for one file, already checked. */
  readonly headers: (path: string, file: ManifestFile) => Readonly<Record<string, string>> | undefined
}

/** One representation of a file, its headers computed once. */
export interface Representation {
  readonly encoding: Encoding | 'identity'
  /** Where the storage layer opens these bytes. */
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

/** The part of a request {@link decideFile} reads. */
export interface FileRequest {
  readonly method: string
  header(name: string): string | undefined
}

/** Where a failure to open a file is logged. */
export interface FileLog {
  error(fields: object, message: string): void
}

export interface FileSelection {
  readonly via: 'route' | 'sendFile'
  readonly conditional: boolean
  readonly strictEncoding?: boolean
}

export interface FileDecision {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly cacheControl: string | undefined
  readonly representation?: Representation
  readonly range?: { readonly start: number; readonly endExclusive: number }
}

/** Compiles the metadata used to negotiate and serve one identity and its variants. */
export function prepareResponseFile(
  path: string,
  entry: ManifestFile,
  policy: FilePolicy,
  locate: (key: string, size: number) => string = key => key,
): PreparedFile {
  const variants = (Object.entries(entry.variants) as Array<[Encoding, ManifestVariant]>).toSorted(
    ([, a], [, b]) => a.size - b.size,
  )
  const lastModified = new Date(entry.lastModified)
  const extra = policy.headers(path, entry)

  const representation = (
    encoding: Encoding | 'identity',
    file: string,
    size: number,
    hash: string,
  ): Representation => {
    const storageKey = locate(file, size)
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
    varyOf(headers, extra?.vary)

    const notModifiedHeaders: Record<string, string> = {
      etag: headers.etag!,
      'last-modified': headers['last-modified']!,
    }
    // RFC 9110 §15.4.5 retains cache metadata from the corresponding 200 response.
    for (const name of ['content-location', 'date', 'expires', 'vary']) {
      const value = headers[name]
      if (value !== undefined) {
        notModifiedHeaders[name] = value
      }
    }

    return {
      encoding,
      path: storageKey,
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

/** Selects the status, headers and storage bytes without opening the body. */
export function decideFile(file: PreparedFile, request: FileRequest, options: FileSelection): FileDecision {
  const cacheControl = options.via === 'route' ? file.cacheControl.route : file.cacheControl.sendFile
  const range = options.conditional && request.method === 'GET' ? request.header('range') : undefined
  const acceptEncoding = request.header('accept-encoding')

  // A range is of the identity's bytes: taken when the client accepts identity, ignored when it does not.
  const ranged = range !== undefined && selectEncoding(acceptEncoding, []) === 'identity'
  const encoding = ranged ? 'identity' : selectEncoding(acceptEncoding, file.encodings)

  if (encoding === undefined && options.strictEncoding) {
    return { status: 406, headers: { vary: 'Accept-Encoding' }, cacheControl: undefined }
  }
  const selected =
    encoding === undefined || encoding === 'identity' ? file.identity : file.variants[file.encodings.indexOf(encoding)]!

  if (options.conditional) {
    if (preconditionFailed(request.header('if-match'), request.header('if-unmodified-since'), selected.validators)) {
      return { status: 412, headers: {}, cacheControl: undefined }
    }

    if (notModified(request.header('if-none-match'), request.header('if-modified-since'), selected.validators)) {
      return { status: 304, headers: selected.notModified, cacheControl }
    }
  }

  if (request.method === 'HEAD') {
    return { status: 200, headers: selected.headers, cacheControl }
  }

  if (ranged && rangeHolds(request.header('if-range'), selected.validators)) {
    const ranges = byteRanges(range, selected.size)

    if (ranges === 'unsatisfiable') {
      return {
        status: 416,
        headers: { 'content-range': `bytes */${selected.size}` },
        cacheControl: undefined,
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

      return { status: 206, headers, cacheControl, representation: selected, range: { start, endExclusive: end + 1 } }
    }
  }

  return { status: 200, headers: selected.headers, cacheControl, representation: selected }
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

/**
 * Writes `Vary` into `headers`: what `headers(file)` asked for, merged with `Accept-Encoding`. A file without variants
 * varies too: a plugin that compresses may code it, and a shared cache must not answer one coding with the other.
 */
function varyOf(headers: Record<string, string>, given: string | undefined): void {
  const reply = {
    getHeader: (name: string) => headers[name],
    header: (name: string, value: string) => {
      headers[name] = value
    },
  }

  if (given !== undefined) {
    appendVary(reply, given.split(','))
  }

  appendVary(reply, ['Accept-Encoding'])
}
