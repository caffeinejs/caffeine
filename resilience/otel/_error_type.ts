// The `error.type` attribute: the error's name, a bounded set in practice, or `_OTHER` when there is none.
export function errorType(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) {
      return name
    }
  }

  return '_OTHER'
}
