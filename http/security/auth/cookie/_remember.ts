// Remember-me series/token helpers. The implementation is shared with the bearer refresh-token grant;
// this module re-exports it under the cookie guard's historical names (`formatRemember`/`parseRemember`).
export { hashToken, newSeries, newToken, tokenMatches } from '../internal/series_token.js'
export {
  formatToken as formatRemember,
  parseToken as parseRemember,
} from '../internal/series_token.js'
