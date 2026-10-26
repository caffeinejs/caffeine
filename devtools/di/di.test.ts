import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools } from '../devtools.js'
import type { BindingRecord, DependencyGraph } from './di.js'

/**
 * The container as the devtools show it: what a reader trusts to find why a service got the dependency it got, so
 * every edge shown must be one the container wires, and nothing the framework binds for itself crowds the listing
 * unless asked for.
 */
describe('DependencyInjectionTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  class Repository {
    find(): string {
      return 'pet'
    }
  }

  class PetService {
    constructor(readonly repository: Repository) {}
  }

  async function boot(): Promise<void> {
    app = createWebApplication().with(devTools()) as WebApplication
    app.container.bind(Repository, t => t.toSelf())
    app.container.bind(PetService, t => t.toFactory(ctx => new PetService(ctx.container.get(Repository))))
    await app.bootstrap()
  }

  async function bindings(query = ''): Promise<BindingRecord[]> {
    return (await (await app!.request(`/devtools/di/bindings${query}`)).json()) as BindingRecord[]
  }

  it("lists the application's bindings and leaves the framework's own out", async () => {
    await boot()

    const listed = await bindings()

    expect(listed.map(binding => binding.key)).toEqual(expect.arrayContaining(['PetService', 'Repository']))
    expect(listed.filter(binding => binding.internal)).toEqual([])
  })

  it('adds the internal bindings when asked', async () => {
    await boot()

    const listed = await bindings('?internal=true')

    expect(listed.filter(binding => binding.internal).length).toBe(listed.length - (await bindings()).length)
    expect(listed.some(binding => binding.internal)).toBe(true)
  })

  it('shows how bindings are wired through their injections', async () => {
    class Shelter {
      constructor(readonly repository: Repository) {}
    }

    app = createWebApplication().with(devTools()) as WebApplication
    app.container.bind(Repository, t => t.toSelf())
    app.container.bind(Shelter, t => t.toSelf([Repository]))
    await app.bootstrap()

    const listed = await bindings()
    const repository = listed.find(binding => binding.key === 'Repository')!
    const shelter = listed.find(binding => binding.key === 'Shelter')!

    expect(shelter.dependencies).toEqual([repository.id])
    expect(repository.dependents).toEqual([shelter.id])
  })

  it('answers one binding by id, and 404 for an id the container does not have', async () => {
    await boot()

    const [first] = await bindings()

    expect(await (await app!.request(`/devtools/di/bindings/${first.id}`)).json()).toEqual(first)
    expect((await app!.request('/devtools/di/bindings/999999')).status).toBe(404)
  })

  it('renders the graph as a Mermaid flowchart naming each binding', async () => {
    await boot()

    const graph = (await (await app!.request('/devtools/di/graph')).json()) as DependencyGraph

    expect(graph.nodes.map(node => node.label)).toEqual(expect.arrayContaining(['PetService', 'Repository']))
    expect(graph.mermaid).toMatch(/^%%\{init.*\nflowchart LR\n/)
    expect(graph.mermaid).toContain('PetService')
  })
})
