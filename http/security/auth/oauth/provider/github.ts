import { DEFAULT_HTTP_TIMEOUT_MS } from '../../internal/remote/config.js'
import type { RemoteAuthenticationTokens } from '../../internal/remote/handler.js'
import type { OAuth2AuthenticationOptions } from '../options.js'

export const GITHUB_ENDPOINTS = {
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  userInfoEndpoint: 'https://api.github.com/user',
  emailsEndpoint: 'https://api.github.com/user/emails',
} as const

export interface GithubPresetOptions {
  /**
   * Fetches the user's verified primary email from `/user/emails`.
   *
   * GitHub returns `email: null` from `/user` unless the user made it public, so without this
   * a GitHub sign-in usually yields no email at all. Off by default: it costs an extra request
   * and needs the `user:email` scope.
   */
  includeEmail?: boolean
  /** Sent on every GitHub API call. GitHub rejects requests without one. */
  userAgent?: string
}

type GithubInput = Omit<
  OAuth2AuthenticationOptions,
  'authorizationEndpoint' | 'tokenEndpoint' | 'userInfoEndpoint' | 'subjectClaim'
>

/**
 * Configures a GitHub sign-in.
 *
 * GitHub speaks OAuth 2.0, not OpenID Connect — no discovery document, no `id_token`, no JWKS
 * — which is why it needs this strategy rather than the OIDC one. Everything encoded here is
 * a way the flow otherwise fails quietly:
 *
 * - `Accept: application/json` on the token request; GitHub answers form-encoded without it.
 * - A `User-Agent` on API calls; GitHub returns 403 without one.
 * - `subjectClaim: 'id'`, because `login` is renameable and so cannot identify a user.
 * - PKCE stays on: GitHub supports S256 and rejects `plain`.
 */
export function githubOAuth2Preset(
  opts: GithubInput & GithubPresetOptions,
): OAuth2AuthenticationOptions {
  const { includeEmail, userAgent = 'caffeinejs', ...rest } = opts

  return {
    ...rest,
    authorizationEndpoint: GITHUB_ENDPOINTS.authorizationEndpoint,
    tokenEndpoint: GITHUB_ENDPOINTS.tokenEndpoint,
    userInfoEndpoint: GITHUB_ENDPOINTS.userInfoEndpoint,
    // GitHub's numeric id is immutable; `login` is a display name the user can change, and
    // reusing a freed login is possible, so it must never be the subject.
    subjectClaim: 'id',
    claimActions: {
      ...rest.claimActions,
      // Authorization policies look for `sub`; without this the subject exists on the ticket
      // but never as a claim, so `@Authorize` cannot see who signed in.
      map: { sub: 'id', ...rest.claimActions?.map },
    },
    // `?? ` alone is not enough: a resolved option bag arrives with `scopes: []`, which is not
    // nullish, and an empty scope means GitHub grants nothing — no `user:email`, so the email
    // enrichment silently 403s. Treat empty as unset; GitHub always needs at least read:user.
    scopes: rest.scopes?.length ? rest.scopes : (includeEmail ? ['read:user', 'user:email'] : ['read:user']),
    userInfoHeaders: {
      'User-Agent': userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
      ...rest.userInfoHeaders,
    },
    tokenRequestHeaders: {
      'User-Agent': userAgent,
      ...rest.tokenRequestHeaders,
    },
    enrichUserInfo: includeEmail
      ? async (userInfo, tokens) => ({
        ...userInfo,
        email: userInfo.email
          ?? await fetchPrimaryEmail(tokens, userAgent, rest.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
      })
      : rest.enrichUserInfo,
  }
}

interface GithubEmail {
  email: string
  primary: boolean
  verified: boolean
}

/**
 * Returns the verified primary email, or undefined.
 *
 * Unverified addresses are ignored: GitHub lets an account hold an address it has not proven
 * ownership of, and treating one as identity would let a user claim someone else's email.
 */
async function fetchPrimaryEmail(
  tokens: RemoteAuthenticationTokens,
  userAgent: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!tokens.accessToken) {
    return undefined
  }

  let response: Response
  try {
    response = await fetch(GITHUB_ENDPOINTS.emailsEndpoint, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent,
      },
      // Every other provider call in the flow carries a deadline; without one here a hung
      // endpoint holds the callback request open, and the email is an optional supplement
      // that is not worth blocking a sign-in for.
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return undefined
  }

  if (!response.ok) {
    return undefined
  }

  const emails = await response.json().catch(() => []) as GithubEmail[]
  return Array.isArray(emails)
    ? emails.find(e => e.primary && e.verified)?.email
    : undefined
}
