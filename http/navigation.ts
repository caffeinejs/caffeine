/** The request headers {@link isNavigation} reads, each `undefined` when the request did not send it. */
export interface NavigationHeaders {
  secFetchMode?: string
  secFetchDest?: string
  accept?: string
}

/**
 * Whether a request is a browser navigating to a document, as opposed to a `fetch`, a script, an image or a
 * client that is not a browser.
 *
 * Fetch Metadata (`Sec-Fetch-Mode` / `Sec-Fetch-Dest`) is the direct answer and every current browser sends
 * it, so when present it decides, including when it says no: a `fetch()` asking for an HTML fragment sends
 * `Sec-Fetch-Mode: cors` next to `Accept: text/html` and is not a navigation. A framed document is one: its
 * mode is `navigate` while its destination is `iframe`. `Accept` is consulted only in its absence, which is
 * real, since browsers omit Fetch Metadata outside secure contexts and plain-http development depends on the
 * fallback; there `text/html` says yes and anything else says no, a bare wildcard included. A request carrying neither
 * header has not said, and the answer is `undefined` for the caller to default as it sees fit.
 *
 * One answer for the whole framework: an authentication scheme deciding between a redirect and a `401`, and
 * a single-page application deciding whether an unmatched URL gets its shell, must agree on what a navigation
 * is, or a request is redirected to sign in by one and answered `404` by the other.
 */
export function isNavigation(headers: NavigationHeaders): boolean | undefined {
  if (headers.secFetchMode !== undefined || headers.secFetchDest !== undefined) {
    return headers.secFetchMode === 'navigate' || headers.secFetchDest === 'document'
  }

  if (headers.accept !== undefined) {
    return headers.accept.includes('text/html')
  }

  return undefined
}
