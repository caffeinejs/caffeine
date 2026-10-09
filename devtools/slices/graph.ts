import { buildBindingGraph } from '@caffeinejs/di/graph'
import { RouteBuilder } from '@caffeinejs/http'

import type { DevToolsSlice } from '../slice.js'

/**
 * The container's dependency graph, `GET <path>/graph`: a node per binding and an edge for every binding an injection
 * receives. It is the `BindingGraph` that `@caffeinejs/di/graph` builds, so that package's renderers draw it.
 */
export function graph(): DevToolsSlice {
  return {
    id: 'graph',
    routes: ({ container }) => [
      new RouteBuilder()
        .method('GET')
        .path('/')
        .handle(() => buildBindingGraph(container.entries())),
    ],
  }
}
