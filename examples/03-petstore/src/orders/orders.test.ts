import { randomUUID } from 'node:crypto'

import { TestContainer, type TestClient, testClient } from '@caffeinejs/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { type PetstoreApp, buildApp } from '../app.js'
import { sessionHeader, signInWithGithub, stubGithub } from '../util/testing/github.js'
import { ordersModule } from './orders.gen.mod.js'
import { OrdersRepository } from './orders.repository.js'
import type { CreateOrderDTO, OrderDTO } from './orders.schemas.js'

/** In-memory stand-in for the Prisma-backed repository, so the feature is tested with no database. */
class FakeOrdersRepository {
  readonly #orders = new Map<string, OrderDTO>()

  reset(): void {
    this.#orders.clear()
  }

  async create(dto: CreateOrderDTO): Promise<OrderDTO> {
    const now = new Date().toISOString()
    const order: OrderDTO = {
      id: randomUUID(),
      petId: dto.petId,
      userId: dto.userId,
      status: dto.status ?? 'PLACED',
      totalAmount: dto.totalAmount ?? '100.00',
      currency: dto.currency ?? 'USD',
      createdAt: now,
      updatedAt: now,
    }
    this.#orders.set(order.id, order)

    return order
  }

  async get(id: string): Promise<OrderDTO | undefined> {
    return this.#orders.get(id)
  }

  async remove(id: string): Promise<boolean> {
    return this.#orders.delete(id)
  }
}

/**
 * Orders, declared as a programmatic router — and therefore driven by a client that knows its routes.
 *
 * `testClient` is `@caffeinejs/brewer` plus the application's lifecycle: the routes come from the value
 * `buildApp` returns, and the transport is that application's own `fetch`, so nothing reaches a socket. A path
 * is never written out — a static segment is a property and a parameterised one is a call — so a route that is
 * renamed, removed or re-typed breaks this file at compile time rather than at run time.
 */
describe('orders feature (via @caffeinejs/testing and brewer)', () => {
  const fake = new FakeOrdersRepository()
  let client: TestClient<PetstoreApp>
  let session: string

  beforeAll(async () => {
    const container = new TestContainer().modules(ordersModule).overrideWithMock(OrdersRepository, fake).build()

    client = testClient(buildApp(container, { logger: false }))
    await client.$ready()

    stubGithub()
    session = await signInWithGithub(client.$app)
  })

  afterAll(async () => {
    await client.$close()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    fake.reset()
  })

  const petId = '019b4132-70aa-764f-b315-e2803d882a24'

  async function placeOrder(): Promise<OrderDTO> {
    const response = await client.orders.post({ body: { petId }, headers: sessionHeader(session) })

    if (response.status !== 201) {
      throw new Error(`Expected 201, got ${response.status}`)
    }

    return await response.json()
  }

  // The response is a union discriminated by `status`, one member per status the route declares, so checking
  // the code is what hands over the body typed from *that* status's schema — a 422 body cannot be read as an
  // order by accident.
  it('places an order and answers 201 with the created resource', async () => {
    const response = await client.orders.post({ body: { petId }, headers: sessionHeader(session) })

    expect(response.status).toBe(201)

    if (response.status === 201) {
      // Typed from the router's `response: { 201: OrderSchema }`, not from what the handler happened to return.
      const order = await response.json()

      expect(order).toMatchObject({ petId, status: 'PLACED', currency: 'USD' })
      expect(order.id).toMatch(/[0-9a-f-]{36}/)
    }
  })

  it('reads an order back by id', async () => {
    const created = await placeOrder()

    const response = await client.orders({ id: created.id }).get({ headers: sessionHeader(session) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: created.id, petId })
  })

  it('answers 404 for an order that does not exist', async () => {
    const response = await client.orders({ id: randomUUID() }).get({ headers: sessionHeader(session) })

    expect(response.status).toBe(404)
  })

  it('cancels an order with 204 and then 404s on read', async () => {
    const created = await placeOrder()

    expect((await client.orders({ id: created.id }).delete({ headers: sessionHeader(session) })).status).toBe(204)
    expect((await client.orders({ id: created.id }).get({ headers: sessionHeader(session) })).status).toBe(404)
  })

  // `.authorize({})` on the router is what `@Authorize()` is on a controller. GitHub is the application's
  // default scheme, so an anonymous caller is refused rather than let through.
  it('refuses an anonymous order', async () => {
    expect((await client.orders.post({ body: { petId } })).status).toBe(401)
  })

  // A body the schema rejects never reaches the handler, and the fallback error handler answers 422 rather
  // than Fastify's default 400.
  it('refuses a body the schema rejects, with the fields that failed', async () => {
    const response = await client.orders.post({
      body: { petId: 'not-a-uuid' },
      headers: sessionHeader(session),
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  /**
   * The half of the contract that never runs.
   *
   * Each of these is a compile error the moment the router's types say so, which is the point of declaring
   * routes as a chain: the client is not generated from a schema file that can drift — it *is* the server's
   * type. Remove a route or rename a path segment and this block stops compiling.
   */
  it('types the surface, so a call the routes do not describe does not compile', async () => {
    // @ts-expect-error -- there is no /invoices
    void (() => client.invoices.get())
    // @ts-expect-error -- /orders answers POST, not PATCH
    void (() => client.orders.patch({ body: { petId } }))
    // @ts-expect-error -- /orders/:id answers GET and DELETE, not PUT
    void (() => client.orders({ id: petId }).put())
    // @ts-expect-error -- the body must satisfy CreateOrderSchema; `petId` is required
    void (() => client.orders.post({ body: {} }))

    expect(true).toBe(true)
  })
})
