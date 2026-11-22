declare const httpsURLBrand: unique symbol

/** An absolute, credential-free HTTPS URL captured when {@link httpsURL} validates it. */
export interface HTTPSURL {
  readonly [httpsURLBrand]: true
  toString(): string
}

const urls = new WeakSet<object>()

/** Validates and snapshots a URL for a complete quoted `href` or `src` value. */
export function httpsURL(value: string | URL): HTTPSURL {
  if (typeof value !== 'string' && !(value instanceof URL)) {
    throw new TypeError('Cannot create an HTTPS URL: expected a string or URL')
  }

  let parsed: URL
  try {
    parsed = new URL(typeof value === 'string' ? value : value.href)
  } catch {
    throw new TypeError('Cannot create an HTTPS URL: expected an absolute HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Cannot create an HTTPS URL: expected an absolute, credential-free HTTPS URL')
  }

  const text = parsed.href
  const result = Object.freeze({ toString: () => text }) as HTTPSURL
  urls.add(result)
  return result
}

export function isHTTPSURL(value: unknown): value is HTTPSURL {
  return typeof value === 'object' && value !== null && urls.has(value)
}
