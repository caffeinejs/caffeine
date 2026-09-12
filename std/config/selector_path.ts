import { ErrConfig } from './errors.js'

const kPathParts = Symbol('@caffeinejs/config:path-parts')

interface PathNode {
  readonly [kPathParts]: readonly string[]
}

/**
 * Extracts the config path a property-chain expression points at, by running it against a proxy that records
 * property access.
 *
 * Only a plain property chain is meaningful here: the recording says *where* to look, so an expression that
 * computes a value instead (an object literal, a method call) has no path to report and throws
 * an {@link ErrConfig} coded `ERR_CONFIG_SELECTOR` rather than silently resolving somewhere unintended.
 */
export function selectorPath(selector: (c: never) => unknown): readonly string[] {
  const result = selector(createNode([]) as never)

  const parts = (result as Partial<PathNode> | null | undefined)?.[kPathParts]

  if (parts === undefined) {
    throw errSelector('the selector must be a plain property chain such as "c => c.app.server", not a computed value')
  }

  if (parts.length === 0) {
    throw errSelector('the selector must name a path, not the config root')
  }

  return parts
}

// A callable target so that invoking a recorded property is trappable — `c => c.server.trim()` has to fail
// loudly rather than record `server.trim` and resolve to nothing at runtime.
function createNode(parts: readonly string[]): unknown {
  const target = (): void => undefined

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === kPathParts) {
        return parts
      }
      if (typeof prop !== 'string') {
        return undefined
      }
      return createNode([...parts, prop])
    },
    apply() {
      throw errSelector('the selector must not call a method on the config')
    },
  })
}

function errSelector(detail: string): ErrConfig {
  return new ErrConfig(`Cannot read config path from selector: ${detail}`, 'ERR_CONFIG_SELECTOR')
}
