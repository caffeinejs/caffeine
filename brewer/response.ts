/**
 * The `Response` a call answers with, with `json()` typed to what the route returns.
 *
 * Everything else `Response` gives — `ok`, `status`, `headers`, `text()`, `body` — is untouched, and checking the
 * status stays with the caller.
 */
export type BrewResponse<T> = Omit<Response, 'json'> & { json(): Promise<T> }
