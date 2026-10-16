// A wildcard keeps its slashes, since carrying them is the point of one. Every part between them is encoded like any
// other value, so a `?`, `#` or `%` stays part of the path rather than ending it or reading as an escape.
export function encodeParam(name: string, value: unknown): string {
  const text = String(value)

  return name === '*' ? text.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(text)
}
