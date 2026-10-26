import { CaffeineIoC, type Container } from '@caffeinejs/di'
import { testClient } from '@caffeinejs/testing/http'
import { describe, expect, it } from 'vitest'

import { diRouter } from './di.js'

/**
 * The container as the devtools show it: what a reader trusts to find why a service got the dependency it got, so
 * every edge shown must be one the container wires, and nothing the framework binds for itself crowds the listing
 * unless asked for.
 */
describe('diRouter', () => {
  class Repository {
    find(): string {
      return 'pet'
    }
  }

  class PetService {
    constructor(readonly repository: Repository) {}
  }

  function client(bind: (container: Container) => void = () => {}) {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Repository, t => t.toSelf())
    container.bind(PetService, t => t.toSelf([Repository]))
    bind(container)

    return testClient(diRouter(container), { container })
  }

  it("lists the application's bindings and leaves the framework's own out", async () => {
    await using di = client()

    const res = await di.di.bindings.get()

    expect(res.status).toBe(200)
    const listed = await res.json()
    expect(listed.map(binding => binding.key)).toEqual(expect.arrayContaining(['PetService', 'Repository']))
    expect(listed.filter(binding => binding.internal)).toEqual([])
  })

  it('adds the internal bindings when asked', async () => {
    await using di = client()

    const own = await (await di.di.bindings.get()).json()
    const all = await (await di.di.bindings.get({ query: { internal: 'true' } })).json()

    expect(all.filter(binding => binding.internal)).toHaveLength(all.length - own.length)
    expect(all.length).toBeGreaterThan(own.length)
  })

  it('shows how bindings are wired through their injections', async () => {
    await using di = client()

    const listed = await (await di.di.bindings.get()).json()
    const repository = listed.find(binding => binding.key === 'Repository')!
    const service = listed.find(binding => binding.key === 'PetService')!

    expect(service.dependencies).toEqual([repository.id])
    expect(repository.dependents).toEqual([service.id])
  })

  it('answers one binding by id, and 404 for an id the container does not have', async () => {
    await using di = client()
    const [first] = await (await di.di.bindings.get()).json()

    const found = await di.di.bindings({ id: String(first!.id) }).get()
    const missing = await di.di.bindings({ id: '999999' }).get()

    expect(found.status).toBe(200)
    expect(await found.json()).toEqual(first)
    expect(missing.status).toBe(404)
  })

  it('renders the graph as a Mermaid flowchart naming each binding', async () => {
    await using di = client()

    const graph = await (await di.di.graph.get()).json()

    expect(graph.nodes.map(node => node.label)).toEqual(expect.arrayContaining(['PetService', 'Repository']))
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'injection', key: 'Repository' }))
    expect(graph.mermaid).toMatch(/^%%\{init.*\nflowchart LR\n/)
    expect(graph.mermaid).toContain('PetService')
  })
})
