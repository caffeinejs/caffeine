import type { AttachmentOptions } from './attachment.js'

// RFC 9110 §8.8.3: one entity tag of a list. Its quoted part holds no quote, so a comma inside one does not split it.
const LISTED_TAG = /(?:W\/)?"[^"]*"/g

// Whether the client holds the current content already, by RFC 9110 §13.2.2: `If-None-Match` decides alone when it
// is sent, comparing tags weakly; otherwise `If-Modified-Since`, to the second, when the content has a Last-Modified
// and the date parses.
export function notModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  { etag, lastModified }: Pick<AttachmentOptions, 'etag' | 'lastModified'>,
): boolean {
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') {
      return true
    }

    if (etag === undefined) {
      return false
    }

    const opaque = withoutWeak(etag)

    return (ifNoneMatch.match(LISTED_TAG) ?? []).some(tag => withoutWeak(tag) === opaque)
  }

  if (ifModifiedSince === undefined || lastModified === undefined) {
    return false
  }

  const date = Date.parse(ifModifiedSince)

  return !Number.isNaN(date) && Math.floor(lastModified.getTime() / 1000) * 1000 <= date
}

function withoutWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}
