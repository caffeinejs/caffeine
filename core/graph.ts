import { Binding } from './binding.js'
import { Key, isNamedKey, keyStr } from './key.js'

interface GraphNode {
  id: number
  label: string
  scopeId: string
  names: string[]
  labels: string[]
  primary: boolean
  lazy: boolean
}

type EdgeKind = 'injection' | 'property-injection' | 'method-injection' | 'named-group' | 'label-group'

interface GraphEdge {
  fromId: number
  toId: number
  kind: EdgeKind
  meta?: string
}

interface BindingGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Renders the {@link CaffeineIoC} container dependencies graph as a `Markdown` table.
 *
 * @param input - The {@link Container} container to render the graph for.
 *
 * @returns A string representing the {@link CaffeineIoC} container dependencies graph as a `Markdown` table.
 */
export function graphToMarkdown(input: Iterable<[Key, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
  const lines: string[] = []

  lines.push('## Bindings')
  lines.push('')
  lines.push('| Key | Dependencies | Scope | Names | Labels | Primary | Lazy |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')

  for (const node of graph.nodes) {
    const deps = nodeDependencyLabels(node.id, graph.edges, nodeById)
    const depsCell = deps.length > 0 ? deps.join(', ') : '-'
    const names = node.names.length > 0 ? node.names.join(', ') : '-'
    const labels = node.labels.length > 0 ? node.labels.join(', ') : '-'
    lines.push(
      `| ${node.label} | ${depsCell} | ${node.scopeId} | ${names} | ${labels} | ${node.primary} | ${node.lazy} |`,
    )
  }

  const depNodes = graph.nodes.filter(n =>
    graph.edges.some(
      e =>
        e.fromId === n.id
        && (e.kind === 'injection' || e.kind === 'property-injection' || e.kind === 'method-injection'),
    ),
  )

  if (depNodes.length > 0) {
    lines.push('')
    lines.push('## Dependencies')
    lines.push('')

    for (const node of depNodes) {
      lines.push(`- ${node.label}`)
      for (const dep of nodeDependencyLabels(node.id, graph.edges, nodeById)) {
        lines.push(`  - ${dep}`)
      }
    }
  }

  const namedGroups = new Map<string, Set<number>>()
  const labelGroups = new Map<string, Set<number>>()

  for (const edge of graph.edges) {
    if (edge.kind === 'named-group' && edge.meta) {
      const s = namedGroups.get(edge.meta) ?? new Set<number>()
      s.add(edge.fromId)
      s.add(edge.toId)
      namedGroups.set(edge.meta, s)
    } else if (edge.kind === 'label-group' && edge.meta) {
      const s = labelGroups.get(edge.meta) ?? new Set<number>()
      s.add(edge.fromId)
      s.add(edge.toId)
      labelGroups.set(edge.meta, s)
    }
  }

  if (namedGroups.size > 0 || labelGroups.size > 0) {
    lines.push('')
    lines.push('## Groups')
    lines.push('')

    for (const [name, ids] of namedGroups) {
      const nodeLabels = [...ids].map(id => nodeById.get(id)?.label ?? String(id))
      lines.push(`- qualifier \`${name}\`: ${nodeLabels.join(', ')}`)
    }

    for (const [label, ids] of labelGroups) {
      const nodeLabels = [...ids].map(id => nodeById.get(id)?.label ?? String(id))
      lines.push(`- label \`${label}\`: ${nodeLabels.join(', ')}`)
    }
  }

  return lines.join('\n')
}

function escapeMermaid(text: string): string {
  return text.replace(/"/g, '\'')
}

/**
 * Renders the {@link CaffeineIoC} container dependencies graph as a `Mermaid` diagram.
 *
 * @param input - The {@link Container} container to render the graph for.
 *
 * @returns A string representing the {@link CaffeineIoC} container dependencies graph as a `Mermaid` diagram.
 */
export function graphToMermaid(input: Iterable<[Key, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const lines: string[] = ['%%{init: {"flowchart": {"htmlLabels": false}}}%%', 'flowchart LR']

  const nodeByIdMermaid = new Map(graph.nodes.map(n => [n.id, n]))

  for (const node of graph.nodes) {
    const deps = nodeDependencyLabels(node.id, graph.edges, nodeByIdMermaid)
    const primaryTag = node.primary ? '\\n[primary]' : ''
    const depsTag = deps.length > 0
      ? `\\n---\\n${deps.map(escapeMermaid)
        .join('\\n')}`
      : ''
    const label = `${escapeMermaid(node.label)}\\n${node.scopeId}${primaryTag}${depsTag}`
    lines.push(`  n${node.id}["${label}"]`)
  }

  for (const edge of graph.edges) {
    const isDashed = edge.kind === 'named-group' || edge.kind === 'label-group'
    const arrow = isDashed ? '-.->' : '-->'
    const label = edge.meta ? `|"${escapeMermaid(edge.meta)}"| ` : ''
    lines.push(`  n${edge.fromId} ${arrow} ${label}n${edge.toId}`)
  }

  return lines.join('\n')
}

function escapeDot(text: string): string {
  return text.replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

/**
 * Renders the {@link CaffeineIoC} container dependencies graph as a Graphviz DOT digraph.
 *
 * @param input - The {@link Container} container to render the graph for.
 *
 * @returns A string representing the {@link CaffeineIoC} container dependencies graph as a Graphviz DOT digraph.
 */
export function graphToDot(input: Iterable<[Key, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const lines: string[] = [
    'digraph bindings {',
    '  rankdir=LR',
    '  node [shape=box, style="rounded,filled", fillcolor=white]',
  ]

  const nodeByIdDot = new Map(graph.nodes.map(n => [n.id, n]))

  for (const node of graph.nodes) {
    const deps = nodeDependencyLabels(node.id, graph.edges, nodeByIdDot)
    const primaryTag = node.primary ? '\\n[primary]' : ''
    const depsTag = deps.length > 0
      ? `\\n---\\n${deps.map(escapeDot)
        .join('\\n')}`
      : ''
    const label = `${escapeDot(node.label)}\\n${node.scopeId}${primaryTag}${depsTag}`
    lines.push(`  n${node.id} [label="${label}"]`)
  }

  for (const edge of graph.edges) {
    const isDashed = edge.kind === 'named-group' || edge.kind === 'label-group'
    const attrs: string[] = []
    if (edge.meta) {
      attrs.push(`label="${escapeDot(edge.meta)}"`)
    }
    if (isDashed) {
      attrs.push('style=dashed')
    }
    const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : ''
    lines.push(`  n${edge.fromId} -> n${edge.toId}${attrStr}`)
  }

  lines.push('}')

  return lines.join('\n')
}

/**
 * Serializes the {@link CaffeineIoC} container dependencies graph as a JSON string.
 *
 * @param input - The {@link Container} container to serialize the graph for.
 *
 * @returns A string representing the {@link CaffeineIoC} container dependencies graph as a JSON string.
 */
export function graphToJson(input: Iterable<[Key, Binding]> | BindingGraph): string {
  return JSON.stringify(resolveGraph(input), null, 2)
}

/**
 * Renders the {@link CaffeineIoC} container dependencies graph as a plain-text tree.
 *
 * @param input - The {@link Container} container to render the graph for.
 *
 * @returns A string representing the {@link CaffeineIoC} container dependencies graph as a plain-text tree.
 */
export function graphToText(input: Iterable<[Key, Binding]> | BindingGraph): string {
  const graph = resolveGraph(input)

  if (graph.nodes.length === 0) {
    return ''
  }

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
  const lines: string[] = []

  for (const node of graph.nodes) {
    lines.push(formatNodeText(node))

    const deps = nodeDependencyLabels(node.id, graph.edges, nodeById, formatNodeText)
    for (let i = 0; i < deps.length; i++) {
      lines.push(`  ${i < deps.length - 1 ? '├─' : '└─'} ${deps[i]}`)
    }
    lines.push('')
  }

  return lines.join('\n')
    .trimEnd()
}

// Graph Internal Utilities

function scopeStr(scopeId: string | symbol): string {
  if (typeof scopeId === 'symbol') {
    return scopeId.description ?? scopeId.toString()
  }
  return String(scopeId)
}

function isBindingGraph(input: Iterable<[Key, Binding]> | BindingGraph): input is BindingGraph {
  return (
    typeof input === 'object'
    && input !== null
    && 'nodes' in input
    && 'edges' in input
    && Array.isArray((input as BindingGraph).nodes)
    && Array.isArray((input as BindingGraph).edges)
  )
}

function resolveGraph(input: Iterable<[Key, Binding]> | BindingGraph): BindingGraph {
  return isBindingGraph(input) ? input : buildBindingGraph(input)
}

function formatNodeText(node: GraphNode): string {
  const attrs: string[] = [`scope=${node.scopeId}`]
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

function nodeDependencyLabels(
  nodeId: number,
  edges: GraphEdge[],
  nodeById: Map<number, GraphNode>,
  fmtNode: (node: GraphNode) => string = n => n.label,
): string[] {
  const injEdges = edges.filter(
    e =>
      e.fromId === nodeId
      && (e.kind === 'injection' || e.kind === 'property-injection' || e.kind === 'method-injection'),
  )

  if (injEdges.length === 0) {
    return []
  }

  const byMeta = new Map<string, number[]>()
  for (const edge of injEdges) {
    const meta = edge.meta ?? ''
    const existing = byMeta.get(meta) ?? []
    existing.push(edge.toId)
    byMeta.set(meta, existing)
  }

  const labels: string[] = []
  for (const [, targetIds] of byMeta) {
    if (targetIds.length === 1) {
      const target = nodeById.get(targetIds[0])
      if (target) {
        labels.push(fmtNode(target))
      }
    } else {
      const targets = targetIds.map(id => nodeById.get(id))
        .filter((n): n is GraphNode => n != null)
      if (targets.length > 0) {
        const sharedNames = targets.reduce<string[]>(
          (acc, node, i) => i === 0 ? [...node.names] : acc.filter(n => node.names.includes(n)),
          [],
        )
        if (sharedNames.length > 0) {
          labels.push(sharedNames[0])
        } else {
          for (const target of targets) {
            labels.push(fmtNode(target))
          }
        }
      }
    }
  }

  const seen = new Set<string>()
  return labels.filter(l => !seen.has(l) && seen.add(l))
}

export function buildBindingGraph(bindings: Iterable<[Key, Binding]>): BindingGraph {
  const entries = Array.from(bindings)
  const keyToId = new Map<Key, number>()
  const nameToIds = new Map<string, number[]>()
  const labelToIds = new Map<string, number[]>()
  const nodes: GraphNode[] = []

  for (const [key, binding] of entries) {
    keyToId.set(key, binding.id)

    const names = binding.names.map(n => keyStr(n))
    const labels = binding.labels.map(l => l.description ?? l.toString())

    nodes.push({
      id: binding.id,
      label: keyStr(key),
      scopeId: scopeStr(binding.scopeId),
      names,
      labels,
      primary: binding.primary ?? false,
      lazy: binding.lazy ?? false,
    })

    for (const name of names) {
      const existing = nameToIds.get(name) ?? []
      existing.push(binding.id)
      nameToIds.set(name, existing)
    }

    for (const label of labels) {
      const existing = labelToIds.get(label) ?? []
      existing.push(binding.id)
      labelToIds.set(label, existing)
    }
  }

  const edges: GraphEdge[] = []

  function addInjectionEdge(fromId: number, injKey: Key | undefined, kind: EdgeKind, meta: string): void {
    if (injKey == null) {
      return
    }

    const directId = keyToId.get(injKey)
    if (directId !== undefined) {
      edges.push({ fromId, toId: directId, kind, meta })
      return
    }

    if (isNamedKey(injKey)) {
      const name = keyStr(injKey)
      const targetIds = nameToIds.get(name)
      if (targetIds) {
        for (const toId of targetIds) {
          edges.push({ fromId, toId, kind, meta })
        }
      }
    }
  }

  for (const [key, binding] of entries) {
    const fromId = keyToId.get(key)!

    for (let i = 0; i < binding.injections.length; i++) {
      addInjectionEdge(fromId, binding.injections[i].key, 'injection', `param[${i}]`)
    }

    for (const [propName, inj] of binding.injectableProperties) {
      addInjectionEdge(fromId, inj.key, 'property-injection', String(propName))
    }

    for (const [methodName, injList] of binding.injectableMethods) {
      for (let i = 0; i < injList.length; i++) {
        addInjectionEdge(fromId, injList[i].key, 'method-injection', `${String(methodName)}[${i}]`)
      }
    }
  }

  for (const [name, ids] of nameToIds) {
    if (ids.length > 1) {
      for (let i = 0; i < ids.length - 1; i++) {
        edges.push({ fromId: ids[i], toId: ids[i + 1], kind: 'named-group', meta: name })
      }
    }
  }

  for (const [label, ids] of labelToIds) {
    if (ids.length > 1) {
      for (let i = 0; i < ids.length - 1; i++) {
        edges.push({ fromId: ids[i], toId: ids[i + 1], kind: 'label-group', meta: label })
      }
    }
  }

  return { nodes, edges }
}
