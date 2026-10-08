import { errMessage } from '@caffeinejs/std/framework/err'

import type { Context } from '../context.js'
import { ErrCSRFConfiguration } from './errors.js'
import { normalizeTrustedOrigin } from './origin.js'

/** The application's word on the origin of a request the check refused: `true` lets it through. */
export type OriginPredicate = (ctx: Context, origin: URL) => boolean | PromiseLike<boolean>

/** The application's word on a request refused for its `Sec-Fetch-Site`: `true` lets it through. */
export type SecFetchSitePredicate = (ctx: Context, site: 'same-site' | 'cross-site') => boolean | PromiseLike<boolean>

/**
 * The `csrf` block of the configuration tree, handed over with `c.config(config.app.csrf)`.
 *
 * Every key is spelled the way its environment variable folds: `CSRF__TRUSTED_ORIGINS__0` sets the first trusted
 * origin.
 */
export interface CSRFConfig {
  /** Whether the check runs at all. Defaults to `true`. */
  enabled?: boolean
  /** Origins a cross-origin request may come from, each `scheme://host[:port]`. */
  trustedOrigins?: readonly string[]
  /**
   * Registered route paths the check leaves alone, each a prefix of whole segments: `/webhooks` covers `/webhooks`
   * and `/webhooks/stripe`, not `/webhooks-old`. Written without the base path. `/` is refused: it would cover every
   * route.
   */
  exclude?: readonly string[]
}

/** A path prefix the check leaves alone: the path itself, and everything under it. */
export interface ExcludedPath {
  readonly exact: string
  readonly under: string
}

/** What one `csrf()` plugin runs on, resolved as its factory ran. */
export interface CSRFOptions {
  readonly enabled: boolean
  readonly trustedOrigins: ReadonlySet<string>
  readonly exclude: readonly ExcludedPath[]
  /** Asked in the order written, ahead of {@link siteChecks}, about a refusal that leaves something to ask. */
  readonly originChecks: readonly OriginPredicate[]
  readonly siteChecks: readonly SecFetchSitePredicate[]
}

/**
 * Folds a block onto the defaults. The checks are code, never configuration, and come in beside it.
 *
 * @throws ErrCSRFConfiguration for a trusted origin that is not one, or an excluded path not starting with `/` or
 * that is `/` itself.
 */
export function resolveCSRFOptions(
  config: CSRFConfig,
  checks: Pick<CSRFOptions, 'originChecks' | 'siteChecks'>,
): CSRFOptions {
  return {
    enabled: config.enabled ?? true,
    trustedOrigins: new Set((config.trustedOrigins ?? []).map(normalizeTrustedOrigin)),
    exclude: (config.exclude ?? []).map(excludedPath),
    ...checks,
  }
}

/** Whether a registered route path is under one of `excluded`. */
export function isExcluded(path: string, excluded: readonly ExcludedPath[]): boolean {
  return excluded.some(({ exact, under }) => path === exact || path.startsWith(under))
}

// A prefix is a run of whole segments, written with or without its trailing slash: the path itself, and what is under
// it. Compared as plain text, `/webhooks` would open `/webhooks-old` as well.
function excludedPath(prefix: string): ExcludedPath {
  if (prefix.startsWith('~/')) {
    throw new ErrCSRFConfiguration(
      errMessage(
        `Cannot exclude "${prefix}" from cross-origin protection: a path is matched after the base path is taken off`,
      )
        .solutions(`Write it as "${prefix.slice(1)}"`)
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  if (!prefix.startsWith('/')) {
    throw new ErrCSRFConfiguration(
      errMessage(`Cannot exclude "${prefix}" from cross-origin protection: a path starts with "/"`)
        .solutions(`Write it as "/${prefix}"`)
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  const exact = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  // Every route sits under `/`: excluding it would turn the check off without saying so.
  if (exact === '') {
    throw new ErrCSRFConfiguration(
      errMessage(`Cannot exclude "${prefix}" from cross-origin protection: it covers every route`)
        .solutions('Turn the check off with enabled(false)', 'Mark the route itself with @CSRFExempt() or csrfExempt()')
        .reference('@caffeinejs/http', ErrCSRFConfiguration)
        .build(),
    )
  }

  return { exact, under: `${exact}/` }
}
