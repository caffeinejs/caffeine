import { mergeValue } from './_merge.js'
import type { RouteGroupDetail } from './detail.js'
import type { RouteAuthz, RouteAuthzOptions, RouteGroupSpec } from './spec.js'

/**
 * Adds one declaration to what a group or a route has declared so far.
 *
 * Nothing is replaced. Each `roles` declaration stays a requirement of its own, so `@Roles('admin')` next to
 * `@Roles('manager')` asks for both, while `@Roles('admin', 'manager')` asks for either. Policies and schemes
 * accumulate, and `allowAnonymous` sticks once declared.
 */
export function foldAuthz(declared: RouteAuthz | undefined, options: RouteAuthzOptions): RouteAuthz {
  const policies = normalizeList(options.policy)
  const roles = options.roles ?? []
  const allowAnonymous = options.allowAnonymous === true

  return {
    allowAnonymous: allowAnonymous || declared?.allowAnonymous === true,
    // A declaration that opens the level asks for nothing. Any other one that names neither a role nor a policy
    // is asking for the default.
    defaultPolicy: declared?.defaultPolicy === true || (!allowAnonymous && policies.length === 0 && roles.length === 0),
    policies: union(declared?.policies, policies),
    roleGroups: roles.length > 0 ? [...(declared?.roleGroups ?? []), [...roles]] : (declared?.roleGroups ?? []),
    schemes: options.schemes === undefined ? declared?.schemes : union(declared?.schemes, options.schemes),
  }
}

/**
 * The authorization in force on a route: what its group declared combined with what it declared itself. Also what
 * a nested group inherits from its parent, which is the same question asked one level up.
 *
 * Requirements only ever accumulate on the way in: the inner level's role groups and policies are added to the
 * outer level's, never merged into them, so a nested group cannot widen what its parent restricted.
 *
 * Whether the result is public is the inner level's call alone. A level declared public opens what declares
 * nothing below it; a level that declares protection is protected whatever was declared above it, and by
 * everything that was declared above it.
 */
export function mergeAuthz(outer: RouteAuthz | undefined, inner: RouteAuthz | undefined): RouteAuthz | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  return {
    allowAnonymous: inner.allowAnonymous,
    defaultPolicy: outer.defaultPolicy || inner.defaultPolicy,
    policies: union(outer.policies, inner.policies),
    roleGroups: [...outer.roleGroups, ...inner.roleGroups],
    schemes: inner.schemes ?? outer.schemes,
  }
}

function union(left: readonly string[] | undefined, right: readonly string[]): readonly string[] {
  return [...new Set([...(left ?? []), ...right])]
}

function normalizeList(value: string | string[] | undefined): string[] {
  if (value == null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Applies an enclosing group's declarations to a group nested inside it, so a sub-group starts from what its
 * parent said and adds to it.
 *
 * Follows the group-to-route merge the compiler already performs: the inner value wins where a field holds one
 * value, and the two are combined where a field holds a set. `catchBy` is the exception — a nested group that
 * names its own handlers replaces the parent's rather than adding to them, because two handlers for one error
 * type is a configuration error, not a merge.
 */
export function inheritGroupSpec<R>(outer: RouteGroupSpec<R>, inner: RouteGroupSpec<R>): RouteGroupSpec<R> {
  return {
    ...inner,
    accept: inner.accept.length > 0 ? inner.accept : outer.accept,
    contentType: inner.contentType !== '' ? inner.contentType : outer.contentType,
    header: mergeMap(outer.header, inner.header),
    bodyLimit: inner.bodyLimit ?? outer.bodyLimit,
    timeout: inner.timeout ?? outer.timeout,
    authz: mergeAuthz(outer.authz, inner.authz),
    config: mergeMap(outer.config, inner.config),
    options: mergeMap(outer.options, inner.options),
    detail: mergeDetail(outer.detail, inner.detail),
    guards: concat(outer.guards, inner.guards),
    catchBy: inner.catchBy?.length ? inner.catchBy : outer.catchBy,
  }
}

/**
 * Combines two groups' detail, one namespace at a time, with the inner group's value merged over the outer's.
 *
 * Per namespace rather than a flat overwrite: two groups annotating different packages both keep theirs, and a
 * namespace both declare folds through the same `mergeValue` every other spec field uses.
 */
function mergeDetail(
  outer: RouteGroupDetail | undefined,
  inner: RouteGroupDetail | undefined,
): RouteGroupDetail | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  const merged: Record<string, unknown> = { ...outer }
  for (const [key, value] of Object.entries(inner)) {
    merged[key] = mergeValue(merged[key], value)
  }

  return merged as RouteGroupDetail
}

function mergeMap<K, V>(outer: Map<K, V> | undefined, inner: Map<K, V> | undefined): Map<K, V> | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  return new Map([...outer, ...inner])
}

function concat<T>(outer: T[] | undefined, inner: T[] | undefined): T[] | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  return [...outer, ...inner]
}
