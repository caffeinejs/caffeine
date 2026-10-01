import { FastifyStaticOptions } from '@fastify/static'

/**
 * A single static mount — a full `@fastify/static` options object (`root` required, plus `prefix`, `index`,
 * `wildcard`, `maxAge`, etc.). The `StaticBuilder` assembles one per `.serve(...)` call and the plugin
 * registers each.
 */
export type StaticMount = FastifyStaticOptions

/**
 * What `.serve(...)` accepts as a mount root: one directory or several, named or as a `file:` URL.
 *
 * Mirrors `@fastify/static`'s own `root`, which tries each directory of an array in turn.
 */
export type StaticRoot = string | URL | ReadonlyArray<string | URL>

/** Caffeine's own settings for a mount, beside the `@fastify/static` options. */
export interface MountOptions {
  /**
   * Exempt every route this mount registers from authentication. Default `false`.
   *
   * `@fastify/static` forwards no route configuration of its own, so an application running
   * `requireAuthenticatedByDefault()` otherwise has to name each public file in `fallbackPolicy`'s `except`,
   * which drifts the moment the build emits another one. A single-page application's bundle wants this: the
   * page that has not signed in yet still has to load its scripts.
   *
   * No principal is established for such a route either, which is the point for an asset — a page pulls
   * dozens, and none of them needs a session decoded.
   */
  anonymous?: boolean
}

/** One mount the plugin registers: the `@fastify/static` options, and what Caffeine adds around them. */
export interface ResolvedMount {
  mount: StaticMount
  anonymous: boolean
}

/** What the feature actually serves, folded from the builder. */
export interface ResolvedStatic {
  mounts: ResolvedMount[]
}

/**
 * One mount as a configuration tree carries it: the root, Caffeine's `anonymous`, and any `@fastify/static`
 * option that is data (`prefix`, `index`, `wildcard`, `maxAge`, ...), handed to `@fastify/static` untouched.
 */
export type StaticMountConfig = { readonly root: string | readonly string[]; readonly anonymous?: boolean } & Readonly<
  Record<string, unknown>
>

/** What `StaticBuilder.config` accepts. */
export interface StaticOptions {
  mounts?: readonly StaticMountConfig[]
}
