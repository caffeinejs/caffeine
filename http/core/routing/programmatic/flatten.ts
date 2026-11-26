import type { ParameterPickOptions } from '@caffeinejs/application/framework'
import { $i, type Container, type ObjectInjectionSpec } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../../error/index.js'
import type { RouteGroupMeta } from '../compile.js'
import { inheritGroupSpec } from '../inherit.js'
import type { RouteOptionsLevel } from '../options.js'
import { normalizeGroupPath, normalizeRoutePath, parseRoutePattern } from '../paths.js'
import { $p } from '../picker.js'
import type { RouteGroupScope } from '../route.js'
import type { ScopeChains } from '../scope_chain.js'
import type { RouteGroupSpec, RouteSpec } from '../spec.js'
import type { RouterState, RouteState } from './state.js'

/** One group ready to compile: the spec the compiler reads, and the name it is known by. */
export interface FlatRouteGroup<R> {
  spec: RouteGroupSpec<R>
  name: string
  /** This router and every router it is nested under, outermost first, each with its full path here. */
  scopes: readonly RouteGroupScope[]
}

/**
 * Turns a router and everything nested under it into one flat list of groups.
 *
 * Flat is what registration wants: a nested group is a group whose path and configuration start from its
 * parent's, not a structure the engine has to walk. Nothing here mutates the router, so mounting the same one
 * into two applications — as tests do — builds it twice rather than accumulating.
 *
 * @param childrenOf - A router's children at one place, the chain `scopes` ending with it, as start-up sees them: those
 *   it declared, by default, and on a server also those its plugins mounted there.
 * @param parent - What `root` nests under when it is not mounted on a server: the controller whose plugin mounted it,
 *   its spec, full path and scope.
 * @param levels - Each place's own route-option levels, kept across walks of one server, so a router's configurer
 *   runs once per place it is mounted at, however often its place is walked.
 */
export function flattenRouter<R>(
  root: RouterState,
  container: Container,
  childrenOf: ChildrenOf = state => state.children,
  parent?: FlatParent<R>,
  levels?: ScopeChains<RouteOptionsLevel[] | undefined>,
): FlatRouteGroup<R>[] {
  const out: FlatRouteGroup<R>[] = []
  walk<R>(root, parent?.path ?? '', parent?.spec, undefined, parent?.scopes ?? [], {
    container,
    childrenOf,
    levels,
    out,
    stack: [],
  })
  return out
}

/** A router's children at one place it is mounted at: `scopes` is its mount chain there, ending with it. */
export type ChildrenOf = (state: RouterState, scopes: readonly RouteGroupScope[]) => readonly RouterState[]

/** What a router nests under when a controller's plugin mounted it. */
export interface FlatParent<R> {
  readonly spec: RouteGroupSpec<R>
  /** The controller's full path: where the router's path starts. */
  readonly path: string
  readonly scopes: readonly RouteGroupScope[]
  /** What the controller's routes run with besides their spec: its instance, hook methods and error handlers. */
  readonly meta?: Pick<RouteGroupMeta<R>, 'onRequest' | 'handleError' | 'hooks'>
}

/**
 * Where a router's routes start at one place: its parent's path, the path it was mounted at, then its group prefix,
 * then its own path. A router's children nest under it.
 */
export function scopePathOf(parentPath: string, prefix: string | undefined, state: RouterState): string {
  const { at, own } = placeOf(state)
  const lead = parentPath + normalizeGroupPath(at)
  return prefix === undefined ? lead + normalizeGroupPath(own) : lead + prefix + normalizeGroupPath(own)
}

/** A router's path split in two: where `mount(path, ...)` put it, and its own. */
function placeOf(state: RouterState): { readonly at: string; readonly own: string } {
  const at = state.at ?? ''
  return { at, own: state.path.slice(at.length) }
}

/** What every level of one walk shares. */
interface Walk<R> {
  readonly container: Container
  readonly childrenOf: ChildrenOf
  readonly levels: ScopeChains<RouteOptionsLevel[] | undefined> | undefined
  readonly out: FlatRouteGroup<R>[]
  /** The routers from the root down to the one being walked. */
  readonly stack: RouterState[]
}

function walk<R>(
  state: RouterState,
  parentPath: string,
  parentSpec: RouteGroupSpec<R> | undefined,
  parentInjection: ObjectInjectionSpec | undefined,
  parentScopes: readonly RouteGroupScope[],
  context: Walk<R>,
): void {
  // Before anything compiles: a router nested in itself would otherwise be walked until the stack runs out.
  assertNotNestedInItself(state, context.stack)
  context.stack.push(state)

  const injection = merge(parentInjection, state.injection)
  const own = state.builder.toRouteGroup<R>()

  // A group prefix comes after the parent's path, and the group's own path is relative to it: the server serves the
  // group's root at its whole path.
  const { at, own: ownPath } = placeOf(state)
  const lead = parentPath + normalizeGroupPath(at)
  const prefix = own.prefix === undefined ? undefined : lead + own.prefix
  const path = own.prefix === undefined ? lead + normalizeGroupPath(ownPath) : normalizeGroupPath(ownPath)
  const scopePath = scopePathOf(parentPath, own.prefix, state)
  own.prefix = prefix
  own.path = path
  own.routes = state.routes.map(route => compileRoute<R>(route, path, injection, context.container))

  // After the whole path it serves at: under a prefix, `path` alone leaves out the parent's.
  const name = state.name ?? defaultGroupName(scopePath)

  // A nested group is a scope of its own, so what a parent router registered reaches it only through this chain.
  // Carrying the chain is what makes `router.with(...)` inherit the way `router.config(...)` does,
  // and the path is where a relative middleware path of that router starts in this group.
  const scopes = [...parentScopes, { key: state, path: scopePath }]

  // This router's own options: a failure in them names it, not a router nested under it. Kept per place, so a second
  // walk of it hands the compiler the levels it already resolved.
  const owned = () => own.options?.map(level => ({ ...level, owner: name }))
  own.options = context.levels === undefined ? owned() : context.levels.at(scopes, owned)

  const spec = parentSpec === undefined ? own : inheritGroupSpec(parentSpec, own)

  assertUniqueRouteNames(spec.routes, name)

  if (spec.routes.length > 0) {
    context.out.push({ spec, name, scopes })
  }

  for (const child of context.childrenOf(state, scopes)) {
    walk<R>(child, scopePath, spec, injection, scopes, context)
  }

  context.stack.pop()
}

/**
 * Refuses a router nested in itself, directly or through the routers under it, by a `.mount(...)` call or by a
 * plugin's `context.server.mount(...)`: its routes would nest without end.
 */
export function assertNotNestedInItself(state: RouterState, stack: readonly RouterState[]): void {
  const at = stack.indexOf(state)

  if (at === -1) {
    return
  }

  const loop = [...stack.slice(at), state].map(router => `"${labelOf(router)}"`).join(' → ')

  throw new ErrConfiguration(
    errMessage(`Cannot nest router "${labelOf(state)}" in itself: ${loop}`)
      .solutions('Remove the mount that closes the loop: a ".mount(...)", or a plugin\'s "context.server.mount(...)"')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/** A router as its author wrote it: the name it was given, or else its own path. */
function labelOf(state: RouterState): string {
  return state.name ?? (state.path === '' ? '/' : state.path)
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
  // the route compiles to the engine's arity-specialized handler like any other.
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
// in what they call a parameter are the same route to a reader. A parameter is left as its name, a wildcard as `all`.
function pathSegments(path: string): string[] {
  return parseRoutePattern(path)
    .map(part =>
      part.kind === 'text' ? part.text : part.kind === 'param' ? part.name : part.kind === 'wildcard' ? 'all' : '',
    )
    .join('')
    .split('/')
    .map(segment => segment.replace(/\?$/, ''))
    .filter(segment => segment.length > 0)
}
