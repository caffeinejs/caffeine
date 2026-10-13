import { CaffeineIoC } from '@caffeinejs/di'
import type { BindingGraph } from '@caffeinejs/di/graph'
import type { WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import type { DevToolsBindingsReport } from '../index.js'
import { get, target } from './fixtures.js'

const kStorage = Symbol('storage')

class Repo {
  readonly kind = 'repo'
}

class Service {
  constructor(readonly repo: Repo) {}
}

class DevOnly {
  readonly kind = 'dev'
}

function container(): CaffeineIoC {
  const container = new CaffeineIoC({ decorators: false, profiles: ['dev'] })
  container.bind(Repo, t => t.toClass(Repo).names('repository').labels(kStorage).primary().lazy())
  container.bind(Service, t => t.toClass(Service, [Repo]))
  container.bind(DevOnly, t => t.toClass(DevOnly).profiles('dev'))
  return container
}

describe('the bindings slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function report(): Promise<DevToolsBindingsReport> {
    app = target({ container: container() })
    await app.bootstrap()

    return (await (await get(app, '/devtools/bindings')).json()) as DevToolsBindingsReport
  }

  it('reports each binding with its key, scope, names, labels and flags', async () => {
    const { bindings } = await report()

    const repo = bindings.find(binding => binding.key === 'Repo')

    expect(repo).toMatchObject({
      names: ['repository'],
      labels: ['storage'],
      primary: true,
      lazy: true,
      async: false,
      internal: false,
      profiles: [],
      type: 'Repo',
    })
    expect(repo?.scope).toMatch(/singleton/)

    expect(bindings.find(binding => binding.key === 'DevOnly')?.profiles).toEqual(['dev'])
  })

  // A UI hides what the framework bound on the application's behalf by default; the flag is what tells them apart.
  it("marks what the framework bound on the application's behalf internal", async () => {
    const { bindings } = await report()

    expect(bindings.find(binding => binding.key === 'ApplicationHealth')?.internal).toBe(true)
    expect(bindings.find(binding => binding.key === 'Service')?.internal).toBe(false)
  })

  // A client draws a binding's dependencies from the graph, finding its node by id.
  it("carries the ids of the graph's nodes, so the two join", async () => {
    const { bindings } = await report()
    const graph = (await (await get(app!, '/devtools/graph')).json()) as BindingGraph

    const ids = (items: readonly { id: number }[]) => items.map(item => item.id).toSorted((a, b) => a - b)

    expect(ids(bindings)).toEqual(ids(graph.nodes))
    expect(bindings.map(binding => binding.key).toSorted()).toEqual(graph.nodes.map(node => node.label).toSorted())
  })
})
