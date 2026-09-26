import { type Binding, injectedBindings } from '../binding.js'
import { DeferredCtor } from '../deferred_ctor.js'
import { collectsMany, namesStage, type ObjectInjection, type ObjectInjections, stageArgs } from '../injection.js'
import { BuiltInStages } from '../injection_resolver.js'
import { type Identifier, type InjectionToken, keyStr } from '../key.js'

export interface GraphNode {
  id: number
  label: string
  scopeID: string
  names: string[]
  labels: string[]
  primary: boolean
  lazy: boolean
}

export type EdgeKind = 'injection' | 'property-injection' | 'method-injection' | 'named-group' | 'label-group'

export interface GraphEdge {
  fromID: number
  toID: number
  kind: EdgeKind

  /**
   * Where an injection edge comes from — `param[0]`, a property name, or `method[0]`, followed by the field path of a
   * `$i.object` field (`param[0].repo`) — or, on a group edge, the name or label the group shares.
   */
  meta?: string

  /**
   * The key the injection asked for, as text. Set on injection edges only.
   */
  key?: string
}

export interface BindingGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Renders the dependency graph as Markdown: a table of the bindings, then each binding's dependencies and the
 * groups of bindings sharing a name or a label.
 *
 * @param input - A container, its `entries()`, or a graph from {@link buildBindingGraph}.
 */
export function graphToMarkdown(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const deps = dependencyLabels(graph)
  const lines: string[] = [
    '## Bindings',
    '',
    '| InjectionToken | Dependencies | Scope | Names | Labels | Primary | Lazy |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const node of graph.nodes) {
    const row = [
      node.label,
      listOrDash(deps.get(node.id)),
      node.scopeID,
      listOrDash(node.names),
      listOrDash(node.labels),
      String(node.primary),
      String(node.lazy),
    ]

    lines.push(`| ${row.map(cell).join(' | ')} |`)
  }

  const withDeps = graph.nodes.filter(node => deps.has(node.id))

  if (withDeps.length > 0) {
    lines.push('', '## Dependencies', '')

    for (const node of withDeps) {
      lines.push(`- ${node.label}`)

      for (const dep of deps.get(node.id)!) {
        lines.push(`  - ${dep}`)
      }
    }
  }

  const groups = groupsOf(graph)

  if (groups.length > 0) {
    const nodeByID = new Map(graph.nodes.map(n => [n.id, n]))

    lines.push('', '## Groups', '')

    for (const group of groups) {
      const members = group.ids.map(id => nodeByID.get(id)?.label ?? String(id))
      lines.push(`- ${group.kind === 'named-group' ? 'qualifier' : 'label'} \`${group.name}\`: ${members.join(', ')}`)
    }
  }

  return lines.join('\n')
}

/**
 * Renders the dependency graph as a Mermaid flowchart.
 *
 * Labels break lines with `\n`, which Mermaid reads as a line break when HTML labels are off, as the diagram's
 * directive sets them.
 *
 * @param input - A container, its `entries()`, or a graph from {@link buildBindingGraph}.
 */
export function graphToMermaid(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const deps = dependencyLabels(graph)
  const lines: string[] = ['%%{init: {"flowchart": {"htmlLabels": false}}}%%', 'flowchart LR']

  for (const node of graph.nodes) {
    lines.push(`  n${node.id}["${caption(node, deps.get(node.id) ?? [], escapeMermaid)}"]`)
  }

  for (const edge of graph.edges) {
    const arrow = isGroupEdge(edge) ? '-.->' : '-->'
    const label = edge.meta ? `|"${escapeMermaid(edge.meta)}"| ` : ''
    lines.push(`  n${edge.fromID} ${arrow} ${label}n${edge.toID}`)
  }

  return lines.join('\n')
}

/**
 * Renders the dependency graph as a Graphviz DOT digraph.
 *
 * @param input - A container, its `entries()`, or a graph from {@link buildBindingGraph}.
 */
export function graphToDot(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const deps = dependencyLabels(graph)
  const lines: string[] = [
    'digraph bindings {',
    '  rankdir=LR',
    '  node [shape=box, style="rounded,filled", fillcolor=white]',
  ]

  for (const node of graph.nodes) {
    lines.push(`  n${node.id} [label="${caption(node, deps.get(node.id) ?? [], escapeDot)}"]`)
  }

  for (const edge of graph.edges) {
    const attrs: string[] = []
    if (edge.meta) {
      attrs.push(`label="${escapeDot(edge.meta)}"`)
    }
    if (isGroupEdge(edge)) {
      attrs.push('style=dashed')
    }

    lines.push(`  n${edge.fromID} -> n${edge.toID}${attrs.length > 0 ? ` [${attrs.join(', ')}]` : ''}`)
  }

  lines.push('}')

  return lines.join('\n')
}

/**
 * Serializes the dependency graph as JSON.
 *
 * @param input - A container, its `entries()`, or a graph from {@link buildBindingGraph}.
 */
export function graphToJSON(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string {
  return JSON.stringify(resolveGraph(input), null, 2)
}

/**
 * Renders the dependency graph as a plain-text tree.
 *
 * @param input - A container, its `entries()`, or a graph from {@link buildBindingGraph}.
 */
export function graphToText(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const deps = dependencyLabels(graph, formatNodeText)
  const lines: string[] = []

  for (const node of graph.nodes) {
    lines.push(formatNodeText(node))

    const nodeDeps = deps.get(node.id) ?? []
    for (let i = 0; i < nodeDeps.length; i++) {
      lines.push(`  ${i < nodeDeps.length - 1 ? '├─' : '└─'} ${nodeDeps[i]}`)
    }

    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

/**
 * Builds the dependency graph of the given `[key, binding]` pairs: a node per pair, and an edge for every binding an
 * injection receives.
 *
 * The graph describes the pairs it is given, so pass an initialized container, or its `entries()`, for one that
 * matches resolution. A key's candidates are the given bindings registered under it, named after it or extending
 * it, and an injection receives what resolution picks: the only candidate or the primary among several, or, for
 * `allOf`, `ordered` and `mapped`, every candidate but the consumer's own. `$i.defer` targets and `$i.object` fields
 * are followed.
 *
 * What the pairs cannot show is left out: bindings the caller did not pass, bindings not yet settled before
 * `init()`, the replacement a `rebind` made for a key other bindings still name or extend, and dependencies wired
 * outside injections — `aliasOf`, `$i.value`, the configuration class behind a `@Provides` method, and aspects.
 */
export function buildBindingGraph(bindings: Iterable<[InjectionToken, Binding]>): BindingGraph {
  const entries = Array.from(bindings)

  // What each key resolves to, collected the way the container collects it: the binding registered under the key,
  // the ones named after it and the ones extending it. Keep in step with `CaffeineIoC.mapUnder`.
  const candidates = new Map<InjectionToken | Identifier, Set<Binding>>()
  const nameMembers = new Map<Identifier, Set<number>>()
  const labelMembers = new Map<symbol, Set<number>>()
  const nodes: GraphNode[] = []

  for (const [key, binding] of entries) {
    nodes.push({
      id: binding.id,
      label: keyStr(key),
      scopeID: text(binding.scopeID),
      names: binding.names.map(name => keyStr(name)),
      labels: binding.labels.map(text),
      primary: binding.primary ?? false,
      lazy: binding.lazy ?? false,
    })

    add(candidates, key, binding)

    for (const name of binding.names) {
      add(candidates, name, binding)
      add(nameMembers, name, binding.id)
    }

    if (binding.extend !== undefined && !binding.configuration) {
      add(candidates, binding.extend, binding)
    }

    for (const label of binding.labels) {
      add(labelMembers, label, binding.id)
    }
  }

  const edges: GraphEdge[] = []

  const visit = (
    owner: Binding,
    ownerKey: InjectionToken,
    inj: ObjectInjection,
    kind: EdgeKind,
    meta: string,
  ): void => {
    if ('children' in inj) {
      for (const prop of Reflect.ownKeys(inj.children)) {
        visit(owner, ownerKey, inj.children[prop], kind, `${meta}.${String(prop)}`)
      }

      return
    }

    // A nested `$i.object` is a descriptor carrying the object stage rather than a bag of children.
    if (namesStage(inj, BuiltInStages.OBJECT)) {
      visit(owner, ownerKey, stageArgs(inj, BuiltInStages.OBJECT) as ObjectInjections, kind, meta)
      return
    }

    if (inj.key == null) {
      return
    }

    const key = inj.key instanceof DeferredCtor ? inj.key.unwrap() : inj.key
    const collects = collectsMany(inj)
    const own = collects && inj.key !== ownerKey ? candidates.get(ownerKey) : undefined

    for (const target of injectedBindings(candidates.get(key) ?? [], collects, own)) {
      edges.push({ fromID: owner.id, toID: target.id, kind, meta, key: keyStr(key) })
    }
  }

  for (const [key, binding] of entries) {
    binding.injections.forEach((inj, i) => visit(binding, key, inj, 'injection', `param[${i}]`))

    for (const [prop, inj] of binding.injectableProperties) {
      visit(binding, key, inj, 'property-injection', String(prop))
    }

    for (const [method, injections] of binding.injectableMethods) {
      injections.forEach((inj, i) => visit(binding, key, inj, 'method-injection', `${String(method)}[${i}]`))
    }
  }

  chainGroups(edges, nameMembers, 'named-group', name => keyStr(name))
  chainGroups(edges, labelMembers, 'label-group', text)

  return { nodes, edges }
}

// Graph Internal Utilities

function add<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const members = index.get(key)
  if (members === undefined) {
    index.set(key, new Set([value]))
  } else {
    members.add(value)
  }
}

// Each group is drawn as one chain of edges from its first member to its last, which is also how `groupsOf` reads
// the groups back.
function chainGroups<K>(
  edges: GraphEdge[],
  groups: Map<K, Set<number>>,
  kind: EdgeKind,
  name: (key: K) => string,
): void {
  for (const [key, members] of groups) {
    const ids = [...members]
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ fromID: ids[i], toID: ids[i + 1], kind, meta: name(key) })
    }
  }
}

function groupsOf(graph: BindingGraph): { kind: EdgeKind; name: string; ids: number[] }[] {
  const groups: { kind: EdgeKind; name: string; ids: number[] }[] = []
  let last: GraphEdge | undefined

  for (const edge of graph.edges) {
    if (!isGroupEdge(edge)) {
      continue
    }

    // Two groups can share a display name, as two symbols can share a description, so a group is a chain, not a
    // name: an edge continuing the previous one belongs to its group.
    if (last !== undefined && last.kind === edge.kind && last.meta === edge.meta && last.toID === edge.fromID) {
      groups[groups.length - 1].ids.push(edge.toID)
    } else {
      groups.push({ kind: edge.kind, name: edge.meta ?? '', ids: [edge.fromID, edge.toID] })
    }

    last = edge
  }

  return groups
}

/**
 * Each node's dependencies, one label per injection site: the target when the site receives one binding, and the key
 * it asked for when it receives several.
 */
function dependencyLabels(
  graph: BindingGraph,
  fmt: (node: GraphNode) => string = node => node.label,
): Map<number, string[]> {
  const nodeByID = new Map(graph.nodes.map(n => [n.id, n]))
  const sites = new Map<number, Map<string, GraphEdge[]>>()

  for (const edge of graph.edges) {
    if (isGroupEdge(edge)) {
      continue
    }

    let bySite = sites.get(edge.fromID)
    if (bySite === undefined) {
      bySite = new Map()
      sites.set(edge.fromID, bySite)
    }

    const site = bySite.get(edge.meta ?? '')
    if (site === undefined) {
      bySite.set(edge.meta ?? '', [edge])
    } else {
      site.push(edge)
    }
  }

  const labels = new Map<number, string[]>()

  for (const [fromID, bySite] of sites) {
    const deps = new Set<string>()

    for (const site of bySite.values()) {
      if (site.length > 1 && site[0].key !== undefined) {
        deps.add(site[0].key)
        continue
      }

      for (const edge of site) {
        const target = nodeByID.get(edge.toID)
        if (target !== undefined) {
          deps.add(fmt(target))
        }
      }
    }

    if (deps.size > 0) {
      labels.set(fromID, [...deps])
    }
  }

  return labels
}

// A node's caption: its key and scope, whether it is primary, then its dependencies. Every part is escaped for the
// target syntax, and the parts are joined with the `\n` both Mermaid and DOT read as a line break in a quoted label.
function caption(node: GraphNode, deps: string[], escape: (text: string) => string): string {
  const parts = [node.label, node.scopeID]
  if (node.primary) {
    parts.push('[primary]')
  }
  if (deps.length > 0) {
    parts.push('---', ...deps)
  }

  return parts.map(escape).join('\\n')
}

// Mermaid's entity codes. `#` goes first, so the `#` that starts `#quot;` is not escaped again.
function escapeMermaid(text: string): string {
  return text.replace(/#/g, '#35;').replace(/"/g, '#quot;')
}

function escapeDot(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function listOrDash(values: string[] | undefined): string {
  return values !== undefined && values.length > 0 ? values.join(', ') : '-'
}

function isGroupEdge(edge: GraphEdge): boolean {
  return edge.kind === 'named-group' || edge.kind === 'label-group'
}

function text(id: string | symbol): string {
  return typeof id === 'symbol' ? (id.description ?? id.toString()) : String(id)
}

function isBindingGraph(input: Iterable<[InjectionToken, Binding]> | BindingGraph): input is BindingGraph {
  return (
    typeof input === 'object' &&
    input !== null &&
    'nodes' in input &&
    'edges' in input &&
    Array.isArray((input as BindingGraph).nodes) &&
    Array.isArray((input as BindingGraph).edges)
  )
}

function resolveGraph(input: Iterable<[InjectionToken, Binding]> | BindingGraph): BindingGraph {
  return isBindingGraph(input) ? input : buildBindingGraph(input)
}

function formatNodeText(node: GraphNode): string {
  const attrs: string[] = [`scope=${node.scopeID}`]
  if (node.primary) {
    attrs.push('primary')
  }
  if (node.lazy) {
    attrs.push('lazy')
  }
  if (node.names.length > 0) {
    attrs.push(`names=[${node.names.join(', ')}]`)
  }
  if (node.labels.length > 0) {
    attrs.push(`labels=[${node.labels.join(', ')}]`)
  }
  return `${node.label}(${attrs.join(' ')})`
}
