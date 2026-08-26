/**
 * Coercion shared by the textual providers — environment variables and command-line arguments both arrive as
 * strings, and both must yield the same value for the same text so that moving a setting from one to the other
 * cannot change its type.
 */

const TRUTHY = ['true', '1', 'yes', 'on']
const FALSY = ['false', '0', 'no', 'off']

export function parseBoolean(value: string): boolean | undefined {
  const n = value.trim().toLowerCase()
  if (TRUTHY.includes(n)) {
    return true
  }
  if (FALSY.includes(n)) {
    return false
  }
  return undefined
}

/** Coerces a textual value to a boolean or number where it unambiguously is one, otherwise leaves it a string. */
export function coerceText(value: string): string | boolean | number {
  const bool = parseBoolean(value)
  if (bool !== undefined) {
    return bool
  }
  const n = Number(value)
  if (!Number.isNaN(n) && value.trim() !== '') {
    return n
  }
  return value
}
