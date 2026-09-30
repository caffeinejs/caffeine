/**
 * The authentication gates installed on the server, each recorded by the gate as it installs.
 *
 * Bound by the authentication feature whether or not a gate is ever registered, so the start-up check that refuses
 * a protected route no gate covers reads one list either way. A gate covers every route of the server context it
 * installed on and of the contexts beneath it; `id` is what it stamps on the routes it owns.
 */
export class AuthenticationGates {
  readonly installed: Array<{ readonly id: symbol; readonly context: object }> = []
}
