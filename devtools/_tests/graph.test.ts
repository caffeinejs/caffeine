import { CaffeineIoC } from '@caffeinejs/di'
import { buildBindingGraph, graphToMermaid, type BindingGraph } from '@caffeinejs/di/graph'
import type { WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { get, target } from './fixtures.js'

class Repo {
  readonly kind = 'repo'
}

class Service {
  constructor(readonly repo: Repo) {}
}

describe('the graph slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function graph(): Promise<BindingGraph> {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Repo, t => t.toClass(Repo))
    container.bind(Service, t => t.toClass(Service, [Repo]))

    app = target({ container })
    await app.bootstrap()

    return (await (await get(app, '/devtools/graph')).json()) as BindingGraph
  }

  // The graph is `@caffeinejs/di/graph`'s own shape, so that package's renderers draw what a client fetched.
  it('answers the graph buildBindingGraph builds of the container', async () => {
    const fetched = await graph()

    const built = buildBindingGraph(app!.container.entries())

    expect(fetched).toEqual(JSON.parse(JSON.stringify(built)))
    expect(graphToMermaid(fetched)).toBe(graphToMermaid(built))
  })

  it('draws an edge for what an injection receives', async () => {
    const { nodes, edges } = await graph()

    const service = nodes.find(node => node.label === 'Service')!
    const repo = nodes.find(node => node.label === 'Repo')!

    expect(edges).toContainEqual(expect.objectContaining({ fromID: service.id, toID: repo.id, kind: 'injection' }))
  })
})
