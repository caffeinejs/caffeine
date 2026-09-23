import { $t } from '@caffeinejs/std'
import { FastifyStaticOptions } from '@fastify/static'

/**
 * The shape of a `static` block an application may declare in its configuration tree.
 *
 * The builder reads no configuration itself: what a fluent method sets is final. This type and
 * {@link staticConfigSchema} exist so an application that wants its mounts to come from a file or the
 * environment can declare the block, and hand the values over in its own callback:
 *
 * ```ts
 * .with(staticFiles((s, { config }) => s.serve(config.static.mounts[0].root)))
 * ```
 */
export interface StaticConfig {
  mounts?: StaticMount[]
}

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
 * A third-party option bag, carried through the tree untouched.
 *
 * It has to be a `Record` rather than a declared object: `Value.Clean` strips every property a schema does not
 * name — even under `additionalProperties: true` — so declaring a partial mirror of `@fastify/static`'s
 * options would silently drop the rest, and a callback option with it. A `Record` of unknowns is validated as
 * "an object" and handed on with every key intact.
 */
const optionBag = (): ReturnType<typeof $t.Record> => $t.Record($t.String(), $t.Unknown())

/**
 * The schema of the `static` block in {@link StaticConfig}.
 *
 * The `@fastify/static` mount options are not ours — they are numerous, they move between releases, and a
 * hand-maintained mirror would reject options that work. The block reaches the builder only through the
 * application's own callback.
 */
export const staticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(optionBag())),
})
