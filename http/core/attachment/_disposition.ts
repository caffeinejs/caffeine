// `Content-Disposition` for a download named `name`: a plain `filename` any client reads, then the exact name as RFC 8187
// UTF-8 in `filename*`, which current clients prefer. A lone surrogate from bad input is written as U+FFFD.
export function contentDisposition(name: string | undefined): string {
  if (name === undefined || name === '') {
    return 'attachment'
  }

  const exact = name.toWellFormed()

  return `attachment; filename="${fallback(exact)}"; filename*=UTF-8''${extended(exact)}`
}

// Every character a plain quoted-string cannot safely carry becomes `_`: anything outside printable ASCII, and the quote
// and backslash that clients unescape unevenly.
function fallback(name: string): string {
  let plain = ''
  for (const char of name) {
    const code = char.codePointAt(0)!
    plain += code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\' ? char : '_'
  }

  return plain
}

// Percent-encoded down to RFC 8187's `attr-char`, which leaves out four characters `encodeURIComponent` keeps.
function extended(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
