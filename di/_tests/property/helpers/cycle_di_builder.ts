import { CaffeineIoC } from '../../../container.js'
import { token } from '../../../key.js'
import { $i } from '../../../injection.js'
import type { Injection } from '../../../injection.js'

export type CycleEdge = {
  from: string
  to: string
  optional?: boolean
  defer?: boolean
}

function fnWithArity(arity: number): (...args: unknown[]) => object {
  switch (arity) {
    case 0:
      return () => ({})
    case 1:
      return (_: unknown) => ({})
    case 2:
      return (_: unknown, __: unknown) => ({})
    case 3:
      return (_: unknown, __: unknown, ___: unknown) => ({})
    case 4:
      return (_: unknown, __: unknown, ___: unknown, ____: unknown) => ({})
    default: {
      const fn = function (this: unknown, ..._args: unknown[]) {
        return {}
      }
      Object.defineProperty(fn, 'length', { value: arity })
      return fn
    }
  }
}

function toInjection(edge: CycleEdge): Injection {
  if (edge.optional) {
    return $i.optional(token<any>(edge.to))
  }

  if (edge.defer) {
    return $i.defer(() => token<any>(edge.to))
  }

  return token<any>(edge.to)
}

export function buildDiFromEdges(edges: CycleEdge[], circularReferences = true): CaffeineIoC {
  const di = new CaffeineIoC({ checks: { circularReferences }, decorators: false })
  const keys = new Set<string>()

  for (const edge of edges) {
    keys.add(edge.from)
    keys.add(edge.to)
  }

  for (const key of keys) {
    const deps = edges.filter(e => e.from === key)

    if (deps.length === 0) {
      di.bind(token<any>(key))
        .toValue({})
      continue
    }

    const injections = deps.map(toInjection)
    di.bind(token<any>(key))
      .toFunction(fnWithArity(deps.length), injections)
  }

  return di
}

export function buildAcyclicEdges(nodeCount: number, edgeMask: boolean[]): CycleEdge[] {
  const keys = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
  const edges: CycleEdge[] = []
  let maskIndex = 0

  for (let i = 1; i < nodeCount; i++) {
    for (let j = 0; j < i; j++) {
      if (edgeMask[maskIndex++]) {
        edges.push({ from: keys[i]!, to: keys[j]! })
      }
    }
  }

  return edges
}

export function addBackEdge(edges: CycleEdge[], from: string, to: string): CycleEdge[] {
  return [...edges, { from, to }]
}
