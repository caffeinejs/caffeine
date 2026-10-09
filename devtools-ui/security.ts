import type { Context } from '@caffeinejs/http'

// A page shows what remote applications sent: nothing in it may run, load from elsewhere, or be framed, and no page
// is kept by a cache.
const HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** Sets the UI's response headers on every response, a failure or a not-found page included. */
export function securityHeaders(ctx: Context, next: () => void): void {
  for (const [name, value] of Object.entries(HEADERS)) {
    ctx.header(name, value)
  }

  next()
}
