import { describe, it, expect } from 'vitest'

import {
  buildBindingGraph,
  graphToMarkdown,
  graphToMermaid,
  graphToDot,
  graphToJSON,
  graphToText,
  type BindingGraph,
} from '../graph/index.js'
import * as root from '../index.js'
import { token } from '../key.js'
import type { Scope } from '../scope.js'
import { binding } from './property/helpers/binding_factory.js'

const TRANSIENT = token<Scope>(Symbol('transient'))

class ServiceA {}
class ServiceB {}
class ServiceC {}

describe('buildBindingGraph', function () {
  it('returns empty graph for empty bindings', function () {
    const graph = buildBindingGraph([])
    expect(graph.nodes).toHaveLength(0)
    expect(graph.edges).toHaveLength(0)
  })

  it('creates a node per binding with correct metadata', function () {
    const b = binding(10, { names: ['svc'], primary: true, lazy: false })
    const graph = buildBindingGraph([[ServiceA, b]])

    expect(graph.nodes).toHaveLength(1)

    const node = graph.nodes[0]
    expect(node.id).toBe(10)
    expect(node.label).toBe('ServiceA')
    expect(node.scopeID).toBe('singleton')
    expect(node.names).toEqual(['svc'])
    expect(node.primary).toBe(true)
    expect(node.lazy).toBe(false)
  })

  it('captures scope description for symbol scopes', function () {
    const b = binding(1, { scopeID: TRANSIENT })
    const graph = buildBindingGraph([[ServiceA, b]])
    expect(graph.nodes[0].scopeID).toBe('transient')
  })

  it('captures a scope registered under a string as it is', function () {
    const b = binding(1, { scopeID: token<Scope>('tenant') })
    const graph = buildBindingGraph([[ServiceA, b]])
    expect(graph.nodes[0].scopeID).toBe('tenant')
  })

  it('creates constructor injection edge', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'injection')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
    expect(edge!.meta).toBe('param[0]')
  })

  it('creates edges for multiple constructor injections', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }, { key: ServiceC }] })
    const bB = binding(2)
    const bC = binding(3)
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])

    const injEdges = graph.edges.filter(e => e.kind === 'injection')
    expect(injEdges).toHaveLength(2)
    expect(injEdges[0].meta).toBe('param[0]')
    expect(injEdges[1].meta).toBe('param[1]')
  })

  it('creates property-injection edge', function () {
    const props = new Map<string, { key: unknown }>([['myProp', { key: ServiceB }]])
    const bA = binding(1, { injectableProperties: props as any })
    const bB = binding(2)
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'property-injection')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
    expect(edge!.meta).toBe('myProp')
  })

  it('creates method-injection edge', function () {
    const methods = new Map<string, { key: unknown }[]>([['init', [{ key: ServiceB }]]])
    const bA = binding(1, { injectableMethods: methods as any })
    const bB = binding(2)
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'method-injection')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
    expect(edge!.meta).toBe('init[0]')
  })

  it('resolves named injection via qualifier lookup', function () {
    const bA = binding(1, { injections: [{ key: 'svc' }] })
    const bB = binding(2, { names: ['svc'] })
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'injection')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
  })

  it('skips injection edge when target is not in graph', function () {
    const bA = binding(1, { injections: [{ key: ServiceC }] })
    const graph = buildBindingGraph([[ServiceA, bA]])
    expect(graph.edges.filter(e => e.kind === 'injection')).toHaveLength(0)
  })

  it('creates named-group edge for bindings sharing a qualifier', function () {
    const bA = binding(1, { names: ['validator'] })
    const bB = binding(2, { names: ['validator'] })
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'named-group')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
    expect(edge!.meta).toBe('validator')
  })

  it('creates label-group edge for bindings sharing a label', function () {
    const label = Symbol('myLabel')
    const bA = binding(1, { labels: [label] })
    const bB = binding(2, { labels: [label] })
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const edge = graph.edges.find(e => e.kind === 'label-group')
    expect(edge).toBeDefined()
    expect(edge!.fromID).toBe(1)
    expect(edge!.toID).toBe(2)
    expect(edge!.meta).toBe('myLabel')
  })

  it('does not create group edge for a single binding with a qualifier', function () {
    const bA = binding(1, { names: ['unique'] })
    const graph = buildBindingGraph([[ServiceA, bA]])
    expect(graph.edges.filter(e => e.kind === 'named-group')).toHaveLength(0)
  })

  it('maps label symbols to their descriptions', function () {
    const label = Symbol('groupTag')
    const b = binding(1, { labels: [label] })
    const graph = buildBindingGraph([[ServiceA, b]])
    expect(graph.nodes[0].labels).toEqual(['groupTag'])
  })

  it('handles a two-node circular dependency without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(graph.nodes).toHaveLength(2)
    const injEdges = graph.edges.filter(e => e.kind === 'injection')
    expect(injEdges).toHaveLength(2)
    expect(injEdges.find(e => e.fromID === 1 && e.toID === 2)).toBeDefined()
    expect(injEdges.find(e => e.fromID === 2 && e.toID === 1)).toBeDefined()
  })

  it('handles a multi-hop cycle without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceC }] })
    const bC = binding(3, { injections: [{ key: ServiceA }] })
    const graph = buildBindingGraph([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])

    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges.filter(e => e.kind === 'injection')).toHaveLength(3)
  })

  it('handles a self-referencing binding without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceA }] })
    const graph = buildBindingGraph([[ServiceA, bA]])

    const selfEdge = graph.edges.find(e => e.fromID === 1 && e.toID === 1)
    expect(selfEdge).toBeDefined()
    expect(selfEdge!.kind).toBe('injection')
  })
})

describe('graphToMarkdown', function () {
  it('returns empty string for empty bindings', function () {
    expect(graphToMarkdown([])).toBe('')
  })

  it('produces a markdown table with binding metadata', function () {
    const b = binding(1, { names: ['myService'], primary: true })
    const output = graphToMarkdown([[ServiceA, b]])

    expect(output).toContain('## Bindings')
    expect(output).toContain('ServiceA')
    expect(output).toContain('singleton')
    expect(output).toContain('myService')
    expect(output).toContain('true')
  })

  it('shows dash when names and labels are absent', function () {
    const b = binding(1)
    const output = graphToMarkdown([[ServiceA, b]])
    const tableRow = output.split('\n').find(l => l.includes('ServiceA'))!
    expect(tableRow).toContain('| - |')
  })

  it('includes dependencies section for injection edges', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('## Dependencies')
    expect(output).toContain('- ServiceA')
    expect(output).toContain('  - ServiceB')
  })

  it('includes groups section for named qualifiers', function () {
    const bA = binding(1, { names: ['validator'] })
    const bB = binding(2, { names: ['validator'] })
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('## Groups')
    expect(output).toContain('qualifier')
    expect(output).toContain('validator')
    expect(output).toContain('ServiceA')
    expect(output).toContain('ServiceB')
  })

  it('includes groups section for label groups', function () {
    const label = Symbol('feature')
    const bA = binding(1, { labels: [label] })
    const bB = binding(2, { labels: [label] })
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('## Groups')
    expect(output).toContain('label')
    expect(output).toContain('feature')
  })

  it('includes dependencies in table column', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const tableRow = output.split('\n').find(l => l.includes('ServiceA'))!
    expect(tableRow).toContain('ServiceB')
  })

  it('uses shared qualifier name for multi-target named injection', function () {
    const bA = binding(1, { injections: [{ key: 'svc' }] })
    const bB = binding(2, { names: ['svc'] })
    const bC = binding(3, { names: ['svc'] })
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])

    expect(output).toContain('- ServiceA')
    expect(output).toContain('  - svc')
    expect(output).not.toContain('  - ServiceB')
    expect(output).not.toContain('  - ServiceC')
  })

  it('renders circular dependency bindings without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    const output = graphToMarkdown([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('- ServiceA')
    expect(output).toContain('  - ServiceB')
    expect(output).toContain('- ServiceB')
    expect(output).toContain('  - ServiceA')
  })

  it('accepts a pre-built BindingGraph', function () {
    const b = binding(1)
    const graph = buildBindingGraph([[ServiceA, b]])
    const output = graphToMarkdown(graph)
    expect(output).toContain('ServiceA')
  })
})

describe('graphToMermaid', function () {
  it('returns empty string for empty bindings', function () {
    expect(graphToMermaid([])).toBe('')
  })

  it('produces valid mermaid flowchart output', function () {
    const b = binding(1)
    const output = graphToMermaid([[ServiceA, b]])

    expect(output).toContain('flowchart LR')
    expect(output).toContain('ServiceA')
    expect(output).toContain('singleton')
  })

  it('uses solid arrows for injection edges', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToMermaid([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('-->')
    expect(output).toContain('param[0]')
  })

  it('uses dashed arrows for named-group edges', function () {
    const bA = binding(1, { names: ['svc'] })
    const bB = binding(2, { names: ['svc'] })
    const output = graphToMermaid([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('-.->')
  })

  it('marks primary bindings in node label', function () {
    const b = binding(1, { primary: true })
    const output = graphToMermaid([[ServiceA, b]])
    expect(output).toContain('[primary]')
  })

  it('includes dependency labels inside node box', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToMermaid([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    const nodeLineA = output.split('\n').find(l => l.includes('n1['))!
    expect(nodeLineA).toContain('---')
    expect(nodeLineA).toContain('ServiceB')
  })

  it('renders circular dependency bindings without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    expect(() =>
      graphToMermaid([
        [ServiceA, bA],
        [ServiceB, bB],
      ]),
    ).not.toThrow()
  })

  it('accepts a pre-built BindingGraph', function () {
    const b = binding(1)
    const graph = buildBindingGraph([[ServiceA, b]])
    const output = graphToMermaid(graph)
    expect(output).toContain('flowchart LR')
  })
})

describe('graphToDot', function () {
  it('returns empty string for empty bindings', function () {
    expect(graphToDot([])).toBe('')
  })

  it('produces a valid DOT digraph', function () {
    const b = binding(1)
    const output = graphToDot([[ServiceA, b]])

    expect(output).toContain('digraph bindings')
    expect(output).toContain('rankdir=LR')
    expect(output).toContain('ServiceA')
    expect(output).toContain('singleton')
    expect(output).toContain('}')
  })

  it('includes edge with label for injection', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToDot([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('->')
    expect(output).toContain('param[0]')
  })

  it('marks group edges as dashed', function () {
    const bA = binding(1, { names: ['svc'] })
    const bB = binding(2, { names: ['svc'] })
    const output = graphToDot([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(output).toContain('style=dashed')
  })

  it('escapes double quotes in labels', function () {
    const b = binding(1)
    const output = graphToDot([[token<Record<string, unknown>>('my"key'), b]])
    expect(output).toContain('\\"')
    expect(output).not.toMatch(/[^\\]"my"key/)
  })

  it('renders circular dependency bindings without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    expect(() =>
      graphToDot([
        [ServiceA, bA],
        [ServiceB, bB],
      ]),
    ).not.toThrow()
  })

  it('accepts a pre-built BindingGraph', function () {
    const b = binding(1)
    const graph = buildBindingGraph([[ServiceA, b]])
    const output = graphToDot(graph)
    expect(output).toContain('digraph bindings')
  })
})

describe('graphToJSON', function () {
  it('serializes an empty graph', function () {
    const output = graphToJSON([])
    const parsed = JSON.parse(output)
    expect(parsed.nodes).toHaveLength(0)
    expect(parsed.edges).toHaveLength(0)
  })

  it('serializes nodes and edges', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToJSON([
      [ServiceA, bA],
      [ServiceB, bB],
    ])
    const parsed = JSON.parse(output)

    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.nodes[0].label).toBe('ServiceA')
    expect(parsed.nodes[0].scopeID).toBe('singleton')
    expect(parsed.edges[0].kind).toBe('injection')
    expect(parsed.edges[0].meta).toBe('param[0]')
  })

  it('produces valid JSON for complex graph', function () {
    const label = Symbol('group')
    const bA = binding(1, { names: ['svc'], labels: [label], injections: [{ key: ServiceB }] })
    const bB = binding(2, { names: ['svc'], labels: [label] })
    const output = graphToJSON([
      [ServiceA, bA],
      [ServiceB, bB],
    ])

    expect(() => JSON.parse(output)).not.toThrow()
    const parsed = JSON.parse(output)
    expect(parsed.nodes[0].names).toEqual(['svc'])
    expect(parsed.nodes[0].labels).toEqual(['group'])
  })

  it('accepts a pre-built BindingGraph', function () {
    const b = binding(1)
    const graph = buildBindingGraph([[ServiceA, b]])
    const output = graphToJSON(graph)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('produces valid JSON for circular dependency bindings', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    const output = graphToJSON([
      [ServiceA, bA],
      [ServiceB, bB],
    ])
    expect(() => JSON.parse(output)).not.toThrow()
    const parsed = JSON.parse(output)
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.edges.filter((e: { kind: string }) => e.kind === 'injection')).toHaveLength(2)
  })
})

describe('graphToText', function () {
  it('returns empty string for empty bindings', function () {
    expect(graphToText([])).toBe('')
  })

  it('shows label and scope on header line', function () {
    const b = binding(1)
    const output = graphToText([[ServiceA, b]])
    expect(output).toContain('ServiceA')
    expect(output).toContain('singleton')
  })

  it('shows primary flag when set', function () {
    const b = binding(1, { primary: true })
    const output = graphToText([[ServiceA, b]])
    expect(output).toContain('primary')
  })

  it('shows lazy flag when set', function () {
    const b = binding(1, { lazy: true })
    const output = graphToText([[ServiceA, b]])
    expect(output).toContain('lazy')
  })

  it('shows qualifier names inline on header line', function () {
    const b = binding(1, { names: ['svc'] })
    const output = graphToText([[ServiceA, b]])
    const line = output.split('\n').find(l => l.includes('ServiceA'))!
    expect(line).toContain('svc')
  })

  it('shows labels inline on header line, one without a description included', function () {
    const b = binding(1, { labels: [Symbol('web'), Symbol()] })
    const line = graphToText([[ServiceA, b]]).split('\n')[0]
    expect(line).toContain('labels=[web, Symbol()]')
  })

  it('renders single dep with └─', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const output = graphToText([
      [ServiceA, bA],
      [ServiceB, bB],
    ])
    expect(output).toContain('└─ ServiceB')
  })

  it('renders multiple deps with ├─ and └─', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }, { key: ServiceC }] })
    const bB = binding(2)
    const bC = binding(3)
    const output = graphToText([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])
    expect(output).toContain('├─ ServiceB')
    expect(output).toContain('└─ ServiceC')
  })

  it('inserts blank line after a binding with deps', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2)
    const bC = binding(3)
    const output = graphToText([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])
    const lines = output.split('\n')
    const treeLastLine = lines.findIndex(l => l.includes('└─ ServiceB'))
    expect(lines[treeLastLine + 1]).toBe('')
  })

  it('inserts blank line after every binding including those without deps', function () {
    const bA = binding(1)
    const bB = binding(2)
    const output = graphToText([
      [ServiceA, bA],
      [ServiceB, bB],
    ])
    expect(output).toContain('\n\n')
  })

  it('uses shared qualifier name for multi-target named injection', function () {
    const bA = binding(1, { injections: [{ key: 'svc' }] })
    const bB = binding(2, { names: ['svc'] })
    const bC = binding(3, { names: ['svc'] })
    const output = graphToText([
      [ServiceA, bA],
      [ServiceB, bB],
      [ServiceC, bC],
    ])
    expect(output).toContain('└─ svc')
    expect(output).not.toContain('└─ ServiceB')
    expect(output).not.toContain('└─ ServiceC')
  })

  it('handles circular dependency bindings without error', function () {
    const bA = binding(1, { injections: [{ key: ServiceB }] })
    const bB = binding(2, { injections: [{ key: ServiceA }] })
    expect(() =>
      graphToText([
        [ServiceA, bA],
        [ServiceB, bB],
      ]),
    ).not.toThrow()
  })

  it('accepts a pre-built BindingGraph', function () {
    const b = binding(1)
    const graph = buildBindingGraph([[ServiceA, b]])
    const output = graphToText(graph)
    expect(output).toContain('ServiceA')
  })
})

describe('escaping', function () {
  // Keys and scopes are free text. A quote, a pipe or a Mermaid entity code left raw corrupts the whole diagram or
  // table, not just the label it sits in.
  const graph: BindingGraph = {
    nodes: [
      {
        id: 1,
        label: 'say "hi" #1; a|b',
        scopeID: 'my"scope#x;',
        names: [],
        labels: [],
        primary: false,
        lazy: false,
      },
    ],
    edges: [],
  }

  it('escapes a pipe in a Markdown table cell', function () {
    const row = graphToMarkdown(graph)
      .split('\n')
      .find(l => l.includes('say'))!

    expect(row).toContain('a\\|b')
    // Seven cells between eight unescaped pipes.
    expect(row.split(/(?<!\\)\|/)).toHaveLength(9)
  })

  it('keeps a backslash that comes before a pipe in a Markdown table cell', function () {
    // Markdown reads a backslash before punctuation as an escape. Left raw, the key's backslash would be taken as
    // escaping the pipe after it and disappear, and the reader would see a|b.
    const row = graphToMarkdown({ nodes: [{ ...graph.nodes[0], label: String.raw`a\|b` }], edges: [] })
      .split('\n')
      .find(l => l.startsWith('| a'))!

    expect(row).toContain(String.raw`| a\\\|b |`)
  })

  it('writes quotes and hashes as Mermaid entity codes, in the label and in the scope', function () {
    const line = graphToMermaid(graph)
      .split('\n')
      .find(l => l.startsWith('  n1['))

    expect(line).toBe('  n1["say #quot;hi#quot; #35;1; a|b\\nmy#quot;scope#35;x;"]')
  })

  it('escapes quotes in a DOT label, in the scope too', function () {
    const line = graphToDot(graph)
      .split('\n')
      .find(l => l.startsWith('  n1 '))

    expect(line).toBe('  n1 [label="say \\"hi\\" #1; a|b\\nmy\\"scope#x;"]')
  })
})

describe('a graph built by hand', function () {
  // A graph can reach the renderers from somewhere other than buildBindingGraph, such as devtools after filtering
  // bindings out of one. Its edges may then name nodes it no longer holds and leave out the optional meta, and
  // every renderer still has to produce output rather than throw or print "undefined".
  const node = (id: number, label: string): BindingGraph['nodes'][number] => ({
    id,
    label,
    scopeID: 'singleton',
    names: [],
    labels: [],
    primary: false,
    lazy: false,
  })

  const graph: BindingGraph = {
    nodes: [node(1, 'Api'), node(2, 'Repo')],
    edges: [
      { fromID: 1, toID: 2, kind: 'injection' },
      { fromID: 2, toID: 9, kind: 'injection', meta: 'param[0]' },
      { fromID: 1, toID: 9, kind: 'named-group' },
    ],
  }

  it('renders every format without an undefined value', function () {
    for (const output of [graphToMarkdown(graph), graphToMermaid(graph), graphToDot(graph), graphToText(graph)]) {
      expect(output).not.toContain('undefined')
    }
  })

  it('draws an edge without meta unlabelled', function () {
    expect(graphToMermaid(graph).split('\n')).toContain('  n1 --> n2')
    expect(graphToDot(graph).split('\n')).toContain('  n1 -> n2')
  })

  it('lists the dependencies it holds nodes for, and a missing group member by its id', function () {
    const markdown = graphToMarkdown(graph)

    expect(markdown).toContain('| Api | Repo |')
    expect(markdown).toContain('| Repo | - |')
    expect(markdown).toMatch(/^- qualifier .*: Api, 9$/m)
  })
})

describe('the package root', function () {
  // The graph has its own entry point, @caffeinejs/di/graph.
  it('exports none of the graph functions', function () {
    for (const name of [
      'buildBindingGraph',
      'graphToDot',
      'graphToJSON',
      'graphToMarkdown',
      'graphToMermaid',
      'graphToText',
    ]) {
      expect(root).not.toHaveProperty(name)
    }
  })
})
