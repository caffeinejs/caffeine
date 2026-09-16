import { mergeValue } from './_merge.js'
import type { RouteGroupDetail } from './detail.js'
import type { RouteAuthzOptions, RouteGroupSpec } from './spec.js'

/**
 * The authorization options actually in force on a route, combining what the group declared with what the
 * route declared.
 *
 * Also what a nested group inherits from its parent, which is the same question asked one level up: a
 * sub-group declaring `roles` adds to the parent's rather than replacing them.
 *
 * Merge follows what `compileRoutePolicy` does with the same inputs: single-valued fields take the inner
 * value when it has one, and `roles`/`policy` are unioned, because the compiled policy requires *both* sets.
 */
export function mergeAuthz(
  outer: RouteAuthzOptions | undefined,
  inner: RouteAuthzOptions | undefined,
): RouteAuthzOptions | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  const roles = [...new Set([...(outer.roles ?? []), ...(inner.roles ?? [])])]
  const policy = [...new Set([...normalizeList(outer.policy), ...normalizeList(inner.policy)])]

  return {
    allowAnonymous: inner.allowAnonymous ?? outer.allowAnonymous,
    schemes: inner.schemes ?? outer.schemes,
    ...(roles.length > 0 ? { roles } : {}),
    ...(policy.length > 0 ? { policy } : {}),
  }
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
