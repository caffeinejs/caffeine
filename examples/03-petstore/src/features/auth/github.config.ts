// GitHub OAuth settings, read straight from the environment (same style as the docs credentials in
// tokens.ts). The values live in the repo-root .env under the PETSTOREDEMO_AUTH_GITHUB_* prefix;
// main.ts loads that file via `dotenv/config`.
const clientID = process.env.PETSTOREDEMO_AUTH_GITHUB_CLIENT_ID ?? ''
const clientSecret = process.env.PETSTOREDEMO_AUTH_GITHUB_CLIENT_SECRET ?? ''

/** Whether real GitHub credentials are present. Shapes the homepage copy. */
export const githubConfigured = clientID !== '' && clientSecret !== ''

// Fixed name for the GitHub session cookie. app.ts sets it on the scheme and the Forward selector
// reads it to route a browser request to the GitHub scheme.
export const GITHUB_SESSION_COOKIE = 'petstore_gh_session'

export const githubConfig = {
  // Placeholder credentials keep the app buildable when the vars are unset (tests, first run) —
  // resolveOAuth2Options rejects empty values. The OAuth flow needs real credentials to reach GitHub.
  clientID: clientID || 'dev-github-client-id',
  clientSecret: clientSecret || 'dev-github-client-secret',
  callbackURL: process.env.PETSTOREDEMO_AUTH_GITHUB_CALLBACK_URL ?? 'http://localhost:9999/login/github/callback',
  homepage: process.env.PETSTOREDEMO_AUTH_GITHUB_HOMEPAGE ?? 'http://localhost:9999/',
  // resolveOAuth2Options requires a session secret of at least MIN_SESSION_SECRET_LENGTH (32)
  // characters; the fallback keeps the demo runnable without a configured secret.
  sessionSecret: process.env.PETSTOREDEMO_AUTH_GITHUB_SESSION_SECRET ?? 'petstore-dev-session-secret-32-chars!!',
} as const
