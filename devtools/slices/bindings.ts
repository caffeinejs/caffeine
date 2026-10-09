import type { Container } from '@caffeinejs/di'
import { buildBindingGraph } from '@caffeinejs/di/graph'
import { RouteBuilder } from '@caffeinejs/http'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsBinding, DevToolsBindingsReport } from '../wire.js'

/**
 * Every binding the container holds, `GET <path>/bindings`: its key, scope, names, labels and flags. A key, a scope,
 * a name and a label read as they do on the binding graph's node, which carries the same id, so the two join on it.
 */
export function bindings(): DevToolsSlice {
  return {
    id: 'bindings',
    routes: ({ container }) => [
      new RouteBuilder()
        .method('GET')
        .path('/')
        .handle(() => report(container)),
    ],
  }
}

function report(container: Container): DevToolsBindingsReport {
  const entries = [...container.entries()]
  const byID = new Map(entries.map(([, binding]) => [binding.id, binding]))

  return {
    bindings: buildBindingGraph(entries).nodes.map((node): DevToolsBinding => {
      const binding = byID.get(node.id)!

      return {
        id: node.id,
        key: node.label,
        scope: node.scopeID,
        names: node.names,
        labels: node.labels,
        primary: node.primary,
        lazy: node.lazy,
        async: binding.async ?? false,
        internal: binding.internal,
        profiles: [...binding.profiles],
        type: binding.type?.name || undefined,
        configuredBy: binding.configuredBy,
      }
    }),
  }
}
