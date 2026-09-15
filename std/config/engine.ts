import type { ConfigSnapshot, PropertySource, ResolutionContext } from './config.js'
import { ErrConfig } from './errors.js'
import { hasPrefixIn, isIndexSegment, joinPath, splitPath } from './path.js'
import type { ConfigSources } from './sources.js'

export interface ConfigEngineOptions {
  sources: ConfigSources
  failFast?: boolean
}

export class ConfigEngine {
  readonly #options: ConfigEngineOptions

  constructor(options: ConfigEngineOptions) {
    this.#options = options
  }

  /**
   * Loads every registered source and merges them into a single snapshot.
   *
   * The provider list is read from the registry on **every** call rather than captured at construction, which
   * is what makes a source registered after bootstrap take effect on the next refresh. Providers arrive
   * already ordered most-recently-registered first, and the merge is first-wins — so the last source
   * registered that defines a key owns it.
   */
  async resolve(ctx: ResolutionContext): Promise<ConfigSnapshot> {
    const providers = this.#options.sources.resolved()

    const loaded = await Promise.all(
      providers.map(async provider => {
        try {
          return await provider.load(ctx)
        } catch (error) {
          if (this.#options.failFast !== false) {
            // A provider that already explained itself is rethrown as is; only an opaque throw gets wrapped,
            // so the specific message is never buried as a `cause` nobody prints.
            throw error instanceof ErrConfig
              ? error
              : new ErrConfig(`Config provider "${provider.id}" failed to load`, 'ERR_CONFIG_PROVIDER', error)
          }
          return []
        }
      }),
    )

    const sources = loaded.flat()

    return { sources, values: mergeSources(sources) }
  }
}

/**
 * Merges the property sources, most recently registered first.
 *
 * One rule, applied uniformly: **the most recently registered source that mentions a path owns that path and
 * everything beneath it.** No earlier source contributes a part of something a later source already spoke
 * about.
 *
 * That is what makes arrays replaced rather than complemented. Every provider flattens `['a','b','c']` into
 * `tags.0/1/2`, so a plain per-key merge would resolve each index on its own and overriding with `['x','y']`
 * would leave `['x','y','c']` — the old tail surviving a source that was supposed to have replaced it, and no
 * way to shorten a list at all.
 *
 * The same rule covers the case a text source creates. `TAGS=a,b` is a single scalar key at `tags`, and it must
 * beat an earlier source's `tags.0/1/2`: without the claim both survive the merge and the materializer lets the
 * indexed children overwrite the scalar, so the value an operator set disappears without a word.
 */
export function mergeSources(sources: readonly PropertySource[]): ConfigSnapshot['values'] {
  const values: ConfigSnapshot['values'] = new Map()
  const claimed = new Set<string>()

  for (const source of sources) {
    const claims = claimsOf(source)

    for (const [key, entry] of source.entries) {
      if (hasPrefixIn(key, claimed)) {
        continue
      }
      if (!values.has(key)) {
        values.set(key, entry)
      }
    }

    // Added only after the whole source is merged, so its own sibling elements all land.
    for (const claim of claims) {
      claimed.add(claim)
    }
  }

  return values
}

/**
 * The paths a source lays claim to.
 *
 * Every key claims itself, so a source that defines `tags` owns `tags` and everything beneath it — the case a
 * text list (`TAGS=a,b`) or a whole-array leaf creates. A key containing an index additionally claims the
 * *parent* of its outermost indexed segment, which is how sibling elements are owned together; claiming the
 * outermost is enough, since `items` covers `items.0.hosts.1` and all the rest.
 *
 * A claim whose indices are not a complete list is rejected. `TAGS__1=z` produces exactly the keys "the whole
 * list is `['z']`" would, minus index `0`, so replacement would silently yield a holed array that surfaces
 * later as a baffling validation error about index 0.
 */
function claimsOf(source: PropertySource): Set<string> {
  const indices = new Map<string, Set<number>>()
  const claims = new Set<string>()

  for (const key of source.entries.keys()) {
    claims.add(key)

    const parts = splitPath(key)
    const at = parts.findIndex(part => isIndexSegment(part))

    if (at <= 0) {
      continue
    }

    // Encoded the way `hasPrefixIn` re-encodes what it probes, so a claimed parent whose own segment holds a
    // literal dot still owns its children.
    const prefix = joinPath(parts.slice(0, at))
    claims.add(prefix)

    let seen = indices.get(prefix)
    if (seen === undefined) {
      seen = new Set()
      indices.set(prefix, seen)
    }
    seen.add(Number(parts[at]))
  }

  for (const [prefix, seen] of indices) {
    for (let i = 0; i < seen.size; i++) {
      if (!seen.has(i)) {
        const indices = [...seen].sort((a, b) => a - b)
        throw new ErrConfig(
          `Cannot merge config array "${prefix}" from "${source.name}": indices [${indices.join(', ')}]` +
            ' are not a complete list',
          'ERR_CONFIG_ARRAY_INDICES',
          undefined,
          'Set the whole array rather than one element: a later-registered source replaces a list, it does not patch it',
          `Start the indices at 0 and leave no gaps, e.g. "${prefix}.0", "${prefix}.1"`,
        )
      }
    }
  }

  return claims
}
