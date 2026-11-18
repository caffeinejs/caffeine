/** A header name, as RFC 9110 writes a token. */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

// What Node writes as a header value: tabs, visible ASCII and spaces, and obs-text. Node refuses anything else in a
// header, and nothing else may reach a part of a multipart body, where a line break would add lines of its own.
export const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

// RFC 9110 §7.6.1: fields that describe one connection, never forwarded. A Node server writes its own, and HTTP/2
// refuses `connection` outright.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
])

/** Whether `name`, lower-case, is a field RFC 9110 §7.6.1 says describes one connection. */
export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name)
}
