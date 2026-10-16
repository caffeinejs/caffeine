export const VERSION_CONSTRAINT = 'version'

export const kVersionHeader = 'Accept-Version'
export const kRouteConstraints = 'caffeine:constraints'

/** One declared route constraint: the value it must match, and the request header it reads, when it reads one. */
export interface ResolvedRouteConstraint {
  value: unknown
  header?: string
}
