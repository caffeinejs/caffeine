import type { DependencyGraph } from '@caffeinejs/devtools'
import { graphToDot, type BindingGraph } from '@caffeinejs/di/graph'
import { Graphviz } from '@hpcc-js/wasm-graphviz'

/** Graphviz, loaded once, on the first graph drawn. */
let graphviz: Promise<Graphviz> | undefined

/**
 * Draws the dependency graph as an SVG document fragment, ready to place in a page.
 *
 * The DOT is written here, from the nodes and edges the devtools answered, never taken from them: Graphviz honours a
 * node's `URL`, so DOT another process wrote could put a link of its choosing in the page. Graphviz escapes every
 * label it draws.
 *
 * @param keep - The ids of the bindings to draw, and the edges between them; every binding when absent.
 */
export async function drawGraph(graph: DependencyGraph, keep?: ReadonlySet<number>): Promise<string> {
  const dot = graphToDot(trusted(graph, keep))

  if (dot === '') {
    return ''
  }

  graphviz ??= Graphviz.load()
  const svg = (await graphviz).dot(dot)

  // Graphviz writes a whole document: the page takes the `<svg>` element alone.
  return svg.slice(svg.indexOf('<svg'))
}

/** The graph with every id a whole number, so `graphToDot` writes each node's name itself, and only what `keep` keeps. */
function trusted(graph: DependencyGraph, keep: ReadonlySet<number> | undefined): BindingGraph {
  const kept = (id: unknown): boolean => Number.isSafeInteger(id) && (keep === undefined || keep.has(id as number))

  return {
    nodes: graph.nodes.filter(node => kept(node.id)),
    edges: graph.edges.filter(edge => kept(edge.fromID) && kept(edge.toID)),
  }
}
