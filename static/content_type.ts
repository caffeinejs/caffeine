import { posix } from 'node:path'

/** What a file is served as, and whether compressing it saves anything. */
export interface ContentType {
  /** The `Content-Type`, with `charset=utf-8` on a `text/*` type. */
  readonly type: string
  readonly compressible: boolean
}

const UTF8 = '; charset=utf-8'

// The extensions a web build emits. A type a file system cannot name is refused at build rather than served as
// `application/octet-stream`. Fonts and images already compressed by their format gain nothing from `br` or `gzip`.
const TABLE: ReadonlyMap<string, ContentType> = new Map(
  (
    [
      [['.html', '.htm'], `text/html${UTF8}`, true],
      [['.css'], `text/css${UTF8}`, true],
      [['.js', '.mjs', '.cjs'], `text/javascript${UTF8}`, true],
      [['.txt'], `text/plain${UTF8}`, true],
      [['.md'], `text/markdown${UTF8}`, true],
      [['.csv'], `text/csv${UTF8}`, true],
      [['.ics'], `text/calendar${UTF8}`, true],
      [['.vtt'], `text/vtt${UTF8}`, true],
      [['.json', '.map'], 'application/json', true],
      [['.jsonld'], 'application/ld+json', true],
      [['.webmanifest'], 'application/manifest+json', true],
      [['.xml'], 'application/xml', true],
      [['.xhtml'], 'application/xhtml+xml', true],
      [['.rss'], 'application/rss+xml', true],
      [['.atom'], 'application/atom+xml', true],
      [['.wasm'], 'application/wasm', true],
      [['.svg'], 'image/svg+xml', true],
      [['.ico'], 'image/x-icon', true],
      [['.bmp'], 'image/bmp', true],
      [['.png'], 'image/png', false],
      [['.apng'], 'image/apng', false],
      [['.jpg', '.jpeg'], 'image/jpeg', false],
      [['.gif'], 'image/gif', false],
      [['.webp'], 'image/webp', false],
      [['.avif'], 'image/avif', false],
      [['.jxl'], 'image/jxl', false],
      [['.woff'], 'font/woff', false],
      [['.woff2'], 'font/woff2', false],
      [['.ttf'], 'font/ttf', true],
      [['.otf'], 'font/otf', true],
      [['.eot'], 'application/vnd.ms-fontobject', true],
      [['.gltf'], 'model/gltf+json', true],
      [['.glb'], 'model/gltf-binary', false],
      [['.mp3'], 'audio/mpeg', false],
      [['.ogg', '.oga'], 'audio/ogg', false],
      [['.opus'], 'audio/opus', false],
      [['.wav'], 'audio/wav', false],
      [['.flac'], 'audio/flac', false],
      [['.m4a'], 'audio/mp4', false],
      [['.aac'], 'audio/aac', false],
      [['.weba'], 'audio/webm', false],
      [['.mp4', '.m4v'], 'video/mp4', false],
      [['.webm'], 'video/webm', false],
      [['.ogv'], 'video/ogg', false],
      [['.mov'], 'video/quicktime', false],
      [['.pdf'], 'application/pdf', false],
      [['.zip'], 'application/zip', false],
      [['.gz', '.tgz'], 'application/gzip', false],
      [['.7z'], 'application/x-7z-compressed', false],
    ] as const
  ).flatMap(([extensions, type, compressible]) => extensions.map(ext => [ext, { type, compressible }] as const)),
)

// A type given in `types` is compressible when it is text a byte-oriented coder shrinks: `text/*`, and the JSON,
// XML and JavaScript families.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript)\b|[^;]*\+(?:json|xml)\b)/i

/**
 * The content type of the file at `path`, a root-relative POSIX path, or `undefined` when nothing types it.
 *
 * `types` comes first: a key naming the path itself wins over one naming its extension (`'.xyz'`), and either
 * wins over the built-in table, which is looked up by the lowercased extension, so `APP.JS` is `.js`. A `text/*`
 * type from `types` gets `charset=utf-8` unless it names a charset of its own. A file with no extension is typed by
 * `types` alone.
 */
export function contentTypeOf(path: string, types: Readonly<Record<string, string>> = {}): ContentType | undefined {
  const ext = posix.extname(path).toLowerCase()
  const given = Object.hasOwn(types, path)
    ? types[path]
    : ext !== '' && Object.hasOwn(types, ext)
      ? types[ext]
      : undefined

  if (given !== undefined) {
    return { type: withCharset(given), compressible: COMPRESSIBLE.test(given) }
  }

  return ext === '' ? undefined : TABLE.get(ext)
}

/** Whether a content type is nonempty and can be sent as a header value. */
export function validContentTypeHeader(type: string): boolean {
  // Printable Latin-1, excluding C1 controls. The build and manifest reader accept the same values.
  return /^[\x20-\x7e\xa0-\xff]+$/.test(type)
}

function withCharset(type: string): string {
  return /^text\//i.test(type) && !/;\s*charset=/i.test(type) ? type + UTF8 : type
}
