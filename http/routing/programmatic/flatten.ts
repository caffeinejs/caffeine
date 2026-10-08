import { $i, type Container, type ObjectInjectionSpec } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import { errMessage } from '@caffeinejs/std/framework/err'

import { boundTo } from '../../binding.js'
import { ErrConfiguration } from '../../error/index.js'
import { normalizeGroupPath, normalizeRoutePath } from '../builder.js'
import { inheritGroupSpec } from '../inherit.js'
import { $p } from '../picker.js'
import type { RouteGroupSpec, RouteSpec } from '../spec.js'
import type { RouterState, RouteState } from './_state.js'

/** One group ready to compile: the spec the compiler reads, and the name it is known by. */
export interface FlatRouteGroup<R> {
  spec: RouteGroupSpec<R>
  name: string
  /** This router and every router it is nested under, outermost first. */
  scopes: readonly RouterState[]
}

/**
 * Turns a router and everything nested under it into one flat list of groups.
 *
 * Flat is what registration wants: a nested group is a group whose path and configuration start from its
 * parent's, not a structure the adapter has to walk. Nothing here mutates the router, so mounting the same one
 * into two applications — as tests do — builds it twice rather than accumulating.
 */
export function flattenRouter<R>(root: RouterState, container: Container): FlatRouteGroup<R>[] {
  const out: FlatRouteGroup<R>[] = []
  walk<R>(root, '', undefined, undefined, [], container, out)
  return out
}

/** The group a nested router starts from: its parent's spec, and the name the parent goes by. */
interface Parent<R> {
  spec: RouteGroupSpec<R>
  name: string
}

function walk<R>(
  state: RouterState,
  parentPath: string,
  parent: Parent<R> | undefined,
  parentInjection: ObjectInjectionSpec | undefined,
  parentScopes: readonly RouterState[],
  container: Container,
  out: FlatRouteGroup<R>[],
): void {
  const path = normalizeGroupPath(`${parentPath}${state.path}`)
  const injection = merge(parentInjection, state.injection)

  const own = state.builder.toRouteGroup<R>()
  own.path = path
  own.routes = state.routes.map(route => compileRoute<R>(route, path, injection, container))

  const name = state.name ?? defaultGroupName(path)

  if (parent !== undefined) {
    assertBindingFollows(parent, own, name)
  }

  const spec = parent === undefined ? own : inheritGroupSpec(parent.spec, own)

  assertUniqueRouteNames(spec.routes, name)

  // A nested group is its own Fastify context, so what a parent router extended cannot reach it through
  // encapsulation. Carrying the chain is what makes `.plugin(...)` inherit the way `.with(...)` does.
  const scopes = [...parentScopes, state]

  if (spec.routes.length > 0) {
    out.push({ spec, name, scopes })
  }

  for (const child of state.children) {
    walk<R>(child, path, { spec, name }, injection, scopes, container, out)
  }
}

/**
 * Refuses a nested router bound to another server than the router it is nested in.
 *
 * A nested router is served where its parent is: the parent's binding wins the merge, so a different one of its own
 * would be dropped without a word. The same binding repeated is accepted, and a router whose parent is unbound binds
 * itself.
 */
function assertBindingFollows<R>(parent: Parent<R>, own: RouteGroupSpec<R>, name: string): void {
  const outer = boundTo(parent.spec.labels)
  const inner = boundTo(own.labels)

  if (outer === undefined || inner === undefined || inner === outer) {
    return
  }

  throw new ErrConfiguration(
    errMessage(
      `Cannot nest router "${name}" in "${parent.name}": it is bound to "${inner}", and "${parent.name}" to "${outer}"`,
    )
      .solutions(
        'A nested router is served where its parent is: drop its own binding',
        `Or mount "${name}" outside "${parent.name}"`,
      )
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function compileRoute<R>(
  state: RouteState,
  groupPath: string,
  groupInjection: ObjectInjectionSpec | undefined,
  container: Container,
): RouteSpec<R> {
  const path = normalizeRoutePath(state.path)

  if (state.handle === undefined) {
    throw new ErrConfiguration(
      errMessage(`Cannot build route "${state.method.join('|')} ${groupPath}${path}": it declares no handler`)
        .solutions('Close the chain with ".handler(fn)"')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  const spec = state.builder.toRoute<R>()
  spec.path = path
  spec.method = state.method
  spec.handle = state.handle

  if (!state.named) {
    spec.name = defaultRouteName(state.method, path)
  }

  // The context first, the dependencies second — the shape the handler is typed against. Both are pickers, so
  // the route compiles to the adapter's arity-specialized handler like any other.
  const deps = compileInjection(container, merge(groupInjection, state.injection))
  spec.parameters = deps === undefined ? [$p.context()] : [$p.context(), deps]

  return spec
}

/**
 * Compiles the dependencies a route declared into the picker that hands them to its handler.
 *
 * The whole spec becomes one `$i.object` descriptor, so resolution is the container's — the same code an
 * `@Injectable` constructor goes through, with the same support for `$i.optional`, `$i.allOf` and the rest.
 *
 * The bag it produces is built once, here, and reused for every request: its fields are getters that resolve
 * through the binding on each access, so a singleton hands back the one instance, a transient a new one, and a
 * request-scoped binding the instance belonging to the scope the request is running in. Nothing about resolution
 * has to happen per request for that to hold, which is why nothing does.
 */
export function compileInjection(
  container: Container,
  spec: ObjectInjectionSpec | undefined,
): ParameterPickOptions<unknown> | undefined {
  if (spec === undefined || isEmpty(spec)) {
    return undefined
  }

  return $p.just(container.resolver($i.object(spec))())
}

function isEmpty(spec: ObjectInjectionSpec): boolean {
  return Object.keys(spec).length === 0 && Object.getOwnPropertySymbols(spec).length === 0
}

function merge(
  outer: ObjectInjectionSpec | undefined,
  inner: ObjectInjectionSpec | undefined,
): ObjectInjectionSpec | undefined {
  if (outer === undefined) {
    return inner
  }
  if (inner === undefined) {
    return outer
  }

  return { ...outer, ...inner }
}

function assertUniqueRouteNames<R>(routes: RouteSpec<R>[], group: string): void {
  const seen = new Set<string | symbol>()

  for (const route of routes) {
    if (seen.has(route.name)) {
      throw new ErrConfiguration(
        errMessage(`Duplicate route name "${String(route.name)}" in "${group}"`)
          .solutions('Give one of the routes its own name with ".name(...)"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    seen.add(route.name)
  }
}

/**
 * The name a route goes by when it was not given one: the method and the path it answers, as `get_pets_id`.
 *
 * It ends up in diagnostics and, for a documented application, in the operation identifier — so it is derived
 * from what the route *is*, and stays stable as long as that does.
 */
function defaultRouteName(method: string[], path: string): string {
  const verb = method.length === 1 ? method[0].toLowerCase() : 'any'
  const segments = pathSegments(path)

  return segments.length === 0 ? `${verb}_index` : `${verb}_${segments.join('_')}`
}

function defaultGroupName(path: string): string {
  const segments = pathSegments(path)

  return segments.length === 0 ? 'Root' : segments.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
}

// Parameter markers, matching constraints and the wildcard are not part of a name — two routes differing only
// in what they call a parameter are the same route to a reader.
function pathSegments(path: string): string[] {
  return path
    .split('/')
    .map(segment => {
      const constraint = segment.indexOf('(')
      const name = constraint === -1 ? segment : segment.slice(0, constraint)
      return name.replace(/^:/, '').replace(/\?$/, '').replace(/\*/g, 'all')
    })
    .filter(segment => segment.length > 0)
}
