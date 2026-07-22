/**
 * Redaction for values that may carry personally identifiable information.
 *
 * Scoped to a single OIDC strategy rather than being a process-wide static.
 *
 * This gates **server-side diagnostics only** — the `message` of an `OidcError`, which the
 * adapter writes to the log. `OidcError.publicMessage`, everything the client can observe,
 * never carries user data regardless of this flag.
 */
export function redactPii(type: string, value: unknown, showPii: boolean): string {
  if (showPii) {
    return String(value)
  }

  return `[PII of type '${type}' is hidden — set showPii to reveal]`
}

/**
 * Redacts a list of values, keeping the count visible.
 *
 * The count alone is often enough to diagnose a mapping problem without exposing anything.
 */
export function redactPiiList(type: string, values: readonly string[], showPii: boolean): string {
  if (showPii) {
    return values.join(', ')
  }

  return `[${values.length} ${type} hidden — set showPii to reveal]`
}
