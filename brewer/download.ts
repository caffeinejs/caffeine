// The client's `$filename`, documented on `FileHelpers`: `filename*` first, then `filename`, each cut to a base name.
export function filenameOf(response: Pick<Response, 'headers'>): string | undefined {
  const disposition = response.headers.get('content-disposition')
  if (disposition === null) {
    return undefined
  }

  const parameters = parametersOf(disposition)
  const extended = parameters.get('filename*')
  const plain = parameters.get('filename')

  return (
    (extended === undefined ? undefined : baseName(decodeExtended(extended))) ??
    (plain === undefined ? undefined : baseName(plain))
  )
}

// The client's `$file`, documented on `FileHelpers`: the body read whole, named, typed and dated by the headers.
export async function fileOf(
  response: Pick<Response, 'headers' | 'url' | 'blob'>,
  fallback = 'download',
): Promise<File> {
  const blob = await response.blob()
  const modified = Date.parse(response.headers.get('last-modified') ?? '')

  return new File([blob], filenameOf(response) ?? nameInURL(response.url) ?? fallback, {
    type: blob.type,
    lastModified: Number.isNaN(modified) ? undefined : modified,
  })
}

// The parameters after a disposition's type, by lower-cased name, the first of each kept. A value is a token running
// to the next `;`, or a quoted string, which may hold `;` and backslash-escaped characters.
function parametersOf(disposition: string): Map<string, string> {
  const parameters = new Map<string, string>()
  let at = disposition.indexOf(';')

  while (at !== -1) {
    const equals = disposition.indexOf('=', at)
    const next = disposition.indexOf(';', at + 1)

    if (equals === -1) {
      break
    }

    // A parameter with no value names nothing; the next one starts at its `;`.
    if (next !== -1 && next < equals) {
      at = next
      continue
    }

    const name = disposition
      .slice(at + 1, equals)
      .trim()
      .toLowerCase()
    let start = equals + 1
    while (disposition[start] === ' ' || disposition[start] === '\t') {
      start++
    }

    let value = ''
    if (disposition[start] === '"') {
      let i = start + 1
      for (; i < disposition.length && disposition[i] !== '"'; i++) {
        if (disposition[i] === '\\' && i + 1 < disposition.length) {
          i++
        }
        value += disposition[i]
      }
      at = disposition.indexOf(';', i)
    } else {
      at = disposition.indexOf(';', start)
      value = disposition.slice(start, at === -1 ? undefined : at).trim()
    }

    if (!parameters.has(name)) {
      parameters.set(name, value)
    }
  }

  return parameters
}

// An RFC 8187 value, `charset'language'percent-encoded`, decoded; `undefined` for a charset no browser is required to
// read, or for bytes that are not text in it.
function decodeExtended(value: string): string | undefined {
  const charsetEnd = value.indexOf("'")
  const languageEnd = value.indexOf("'", charsetEnd + 1)
  if (charsetEnd === -1 || languageEnd === -1) {
    return undefined
  }

  const charset = value.slice(0, charsetEnd).toLowerCase()
  const encoded = value.slice(languageEnd + 1)

  if (charset === 'utf-8') {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return undefined
    }
  }

  // Each Latin-1 byte is the code point of the same number.
  if (charset === 'iso-8859-1') {
    return encoded.replaceAll(/%([0-9a-f]{2})/gi, (_escape, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
  }

  return undefined
}

// Control characters, and the ones that reorder how a name reads, which can show `exe` as `txt`. Not every invisible
// character: the zero-width joiner writes emoji, and words in some scripts.
const HIDDEN = /[\p{Cc}\p{Bidi_Control}]/gu

// What Windows refuses in a name, where `:` would name a drive or a stream.
const RESERVED = /[<>:"|?*]/g

// A device Windows opens in whatever directory it is named, with or without an extension.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i

// The last segment of a name that may hold a path, `/` or `\` separated, made a plain file on any system;
// `undefined` when nothing is left that a file could be named, such as `..`.
function baseName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined
  }

  const last = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const base = last.replaceAll(HIDDEN, '').replaceAll(RESERVED, '_').trim()

  if (/^[. ]*$/.test(base)) {
    return undefined
  }

  return DEVICE.test(base) ? `_${base}` : base
}

// The last segment of a URL's path, decoded, as a download that names itself nowhere is saved under.
function nameInURL(url: string): string | undefined {
  if (url === '') {
    return undefined
  }

  const path = new URL(url).pathname
  const last = path.slice(path.lastIndexOf('/') + 1)

  try {
    return baseName(decodeURIComponent(last))
  } catch {
    return baseName(last)
  }
}
