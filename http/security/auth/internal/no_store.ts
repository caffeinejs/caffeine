import type { Context } from '../../../context.js'

/**
 * Marks a response as not to be stored by any cache.
 *
 * For every response that sets a session cookie or carries a sign-in URL with its `state` in it: a shared cache
 * that kept one would hand one user's session, or one browser's sign-in round trip, to the next caller of the URL.
 */
export function noStore(ctx: Context): void {
  ctx.header('cache-control', 'no-store')
}
