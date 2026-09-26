/**
 * What a guard decided, when it says more than `true` or `false`. `runGuards` reads nothing else, so a
 * transport's own result class implements this and adds only its factories.
 *
 * `unauthenticated` on a denial says the caller is not known, rather than known and not allowed. The
 * transport answers each with its own status: HTTP `401` and `403`, gRPC `UNAUTHENTICATED` and
 * `PERMISSION_DENIED`.
 */
export interface GuardOutcome {
  readonly ok: boolean
  readonly reason: string
  readonly unauthenticated?: boolean
}

/**
 * The shape a transport's guard interface extends, `I` being what that transport hands a guard.
 *
 * Each transport declares its own guard interface on top of this, and its input carries a literal `kind`
 * (`'http'`, …). One class serves several transports by implementing each of their interfaces, which makes
 * it accept every input and narrow on `kind` before reading a transport's fields.
 */
export interface BaseGuard<I> {
  guard(input: I): boolean | GuardOutcome | PromiseLike<boolean | GuardOutcome>
}
