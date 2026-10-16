import { ErrBrewPathValue } from './errors.js'

// A wildcard keeps its slashes, since carrying them is the point of one. Every part between them is encoded like any
// other value, so a `?`, `#` or `%` stays part of the path rather than ending it or reading as an escape. A part of
// `.` or `..` is refused: the URL standard resolves it as a step along the path, encoded or not.
export function encodeParam(path: string, name: string, value: unknown): string {
  const text = String(value)
  const parts = name === '*' ? text.split('/') : [text]

  if (parts.some(part => part === '.' || part === '..')) {
    throw new ErrBrewPathValue(path, name, text)
  }

  return parts.map(encodeURIComponent).join('/')
}
