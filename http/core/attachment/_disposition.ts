// `Content-Disposition` for a download named `name`: a plain `filename` any client reads, then the exact name as
// RFC 8187 UTF-8 in `filename*`, which current clients prefer. A lone surrogate from bad input is written as U+FFFD.
export function contentDisposition(name: string | undefined): string {
  const file = name === undefined ? '' : fileName(name)

  if (file === '') {
    return 'attachment'
  }

  return `attachment; filename="${fallback(file)}"; filename*=UTF-8''${extended(file)}`
}

// A name is one file, never a place: its last `/` or `\` segment, without the control characters that could cut it
// short or the marks that reorder how it reads (RFC 6266 §4.3). Empty when no file could be called what is left.
function fileName(name: string): string {
  const last = name
    .toWellFormed()
    .split(/[/\\]/)
    .at(-1)!
    .replaceAll(/[\p{Cc}\p{Bidi_Control}\uFEFF]/gu, '')

  return last === '.' || last === '..' ? '' : last
}

// Every character a plain quoted-string cannot safely carry becomes `_`: anything outside printable ASCII, and the
// quote and backslash that clients unescape unevenly.
function fallback(name: string): string {
  return name.replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/gu, '_')
}

// Percent-encoded down to RFC 8187's `attr-char`, which leaves out four characters `encodeURIComponent` keeps.
function extended(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
}
