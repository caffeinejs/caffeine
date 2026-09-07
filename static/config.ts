import { $t } from '@caffeinejs/std'

import type { SPAOptions } from './spa.js'
import type { StaticMount } from './static.js'

/**
 * The static feature's slice of the configuration tree.
 *
 * `mounts` mirrors the `.serve(...)` calls and `spa` the `.spa(...)` one, so a deployment can repoint a root
 * or a prefix without a rebuild.
 *
 * **A higher-priority source replaces `mounts` whole rather than patching an element** — the array rule the
 * merge engine applies everywhere. `.serve()` is additive in code, but `STATIC__MOUNTS__0__ROOT` is not: it
 * declares the entire list. That is what makes it possible to *remove* a mount from a config file at all.
 */
export interface StaticConfigSlice {
  mounts?: StaticMount[]
  spa?: SPAOptions & { root: string }
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

const spaCacheSchema = $t.Union([
  $t.Literal(false),
  $t.Object({
    immutable: $t.Optional($t.List($t.String())),
    shell: $t.Optional($t.String()),
    other: $t.Optional($t.String()),
  }),
])

/**
 * The schema governing the static slice.
 *
 * The SPA options are ours, so they are declared and validated. The `@fastify/static` mount options are not —
 * they are numerous, they move between releases, and a hand-maintained mirror would reject options that work.
 * Nothing is defaulted here: {@link resolveSPASettings} already owns the SPA defaults.
 */
export const staticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(optionBag())),
  spa: $t.Optional(
    $t.Object({
      root: $t.String(),
      index: $t.Optional($t.String()),
      prefix: $t.Optional($t.String()),
      exclude: $t.Optional($t.List($t.String())),
      include: $t.Optional($t.List($t.String())),
      derive: $t.Optional($t.Boolean()),
      navigationOnly: $t.Optional($t.Boolean()),
      onMissingIndex: $t.Optional($t.UnionEnum(['error', 'skip'])),
      cache: $t.Optional(spaCacheSchema),
      static: $t.Optional(optionBag()),
    }),
  ),
})
