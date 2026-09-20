/**
 * `value` as an RFC 9110 §5.6.4 quoted-string, the quotes included.
 *
 * `"` and `\` are escaped. What no header value can carry is dropped — control characters, a line break most of
 * all, and anything past U+00FF: Node refuses to send a header holding one, which turns a realm with a stray
 * character into a 500 for every request that is challenged.
 */
export function quotedString(value: string): string {
  return `"${value.replace(/[^\t\x20-\x7E\x80-\xFF]/g, '').replace(/["\\]/g, '\\$&')}"`
}

/**
 * One RFC 9110 §11.6.1 challenge: the scheme, then its parameters in the order given. A parameter that is
 * `undefined` is left out, and a challenge with none is the bare scheme.
 */
export function challenge(scheme: string, parameters: Record<string, string | undefined> = {}): string {
  const rendered = Object.entries(parameters)
    .filter((parameter): parameter is [string, string] => parameter[1] !== undefined)
    .map(([name, value]) => `${name}=${quotedString(value)}`)

  return rendered.length === 0 ? scheme : `${scheme} ${rendered.join(', ')}`
}
