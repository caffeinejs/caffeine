import type { OIDCMeta } from './index.js'

/**
 * Holds what the OIDC routes are built from, for whichever authentication gate claims them.
 *
 * Bound by the authentication feature only when an OIDC/OAuth strategy was configured, so an absent binding
 * still means "no OIDC" with no flag to read back. `claimed` is what keeps several gates from registering the
 * routes twice: the first gate allowed to takes them, the first gate on a server, servers being built the
 * application's own first.
 */
export class OIDCRoutesRef {
  claimed = false

  constructor(readonly meta: OIDCMeta) {}
}
