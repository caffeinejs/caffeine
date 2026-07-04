import fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { Injectable } from '@caffeinejs/core'
import { Application, Controller, Get, Post, Params, body, newHTTP } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '@caffeinejs/http'
import { ErrFetchFailed, typedClient } from './index.js'
import type { Fetchable } from './index.js'

interface Pet { id: number, species: string, name: string }
interface PetSummary { id: number, name: string }

@Injectable()
class PetStore {
  #pets: Pet[] = []
  #next = 1

  add(species: string, name: string): Pet {
    const pet = { id: this.#next++, species, name }
    this.#pets.push(pet)
    return pet
  }

  all(): PetSummary[] {
    return this.#pets.map(({ id, name }) => ({ id, name }))
  }
}

@Controller('/pets', [PetStore])
class PetsRouter {
  #store: PetStore

  constructor(store: PetStore) {
    this.#store = store
  }

  @Get('/')
  all(): PetSummary[] {
    return this.#store.all()
  }

  @Post('/')
  @Params([body()])
  adopt(data: { species: string, name: string }): Pet {
    return this.#store.add(data.species, data.name)
  }

  @Get('/status')
  status(): string {
    return 'ok'
  }
}

void [PetStore, PetsRouter]

describe('typedClient()', () => {
  let app: Application<any, any, any>
  let baseUrl: string

  beforeAll(async () => {
    app = newHTTP(fastifyAdapterFactory(fastify({ logger: false })))
    await app.ready()
    baseUrl = await app.instance.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('resolves all() to controller return type and parses JSON array', async () => {
    const client = typedClient(PetsRouter, baseUrl)
    const pets = await client.all()

    expectTypeOf(pets).toEqualTypeOf<PetSummary[]>()
    expect(pets).toBeInstanceOf(Array)
  })

  it('resolves adopt() to controller return type and parses JSON object', async () => {
    const client = typedClient(PetsRouter, baseUrl)
    const pet = await client.adopt({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ species: 'cat', name: 'Luna' }),
    })

    expectTypeOf(pet).toEqualTypeOf<Pet>()
    expect(pet).toMatchObject({ species: 'cat', name: 'Luna' })
  })

  it('resolves status() to string and returns plain text', async () => {
    const client = typedClient(PetsRouter, baseUrl)
    const result = await client.status()

    expectTypeOf(result).toEqualTypeOf<string>()
    expect(result).toBe('ok')
  })

  it('works with in-process adapter', async () => {
    const client = typedClient(PetsRouter, app)
    const pets = await client.all()
    expectTypeOf(pets).toEqualTypeOf<PetSummary[]>()
    expect(pets).toBeInstanceOf(Array)
  })

  it('returns independent clients for same controller with different targets', async () => {
    const remote = typedClient(PetsRouter, baseUrl)
    const inProcess = typedClient(PetsRouter, app)
    const [remoteResult, inProcessResult] = await Promise.all([remote.all(), inProcess.all()])

    expect(remoteResult).toBeInstanceOf(Array)
    expect(inProcessResult).toBeInstanceOf(Array)
  })

  it('throws ErrFetchFailed when response is not ok', async () => {
    const mockAdapter: Fetchable = {
      fetch: async () => new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    }

    const client = typedClient(PetsRouter, mockAdapter)

    await expect(client.all()).rejects.toThrow(ErrFetchFailed)
  })

  it('ErrFetchFailed carries status, headers, and parsed body', async () => {
    const mockAdapter: Fetchable = {
      fetch: async () => new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    }

    const client = typedClient(PetsRouter, mockAdapter)

    let err!: ErrFetchFailed
    try {
      await client.all()
    } catch (e) {
      err = e as ErrFetchFailed
    }

    expect(err).toBeInstanceOf(ErrFetchFailed)
    expect(err.status).toBe(404)
    expect(err.headers).toBeInstanceOf(Headers)
    expect(err.headers.get('content-type')).toContain('application/json')
    expect(err.body).toMatchObject({ error: 'not found' })
    expect(err.message).toContain('404')
  })

  it('ErrFetchFailed with non-JSON error body captures text', async () => {
    const mockAdapter: Fetchable = {
      fetch: async () => new Response('Service Unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    }

    const client = typedClient(PetsRouter, mockAdapter)

    let err!: ErrFetchFailed
    try {
      await client.status()
    } catch (e) {
      err = e as ErrFetchFailed
    }

    expect(err).toBeInstanceOf(ErrFetchFailed)
    expect(err.status).toBe(503)
    expect(err.headers).toBeInstanceOf(Headers)
    expect(err.headers.get('content-type')).toContain('text/plain')
    expect(err.body).toBe('Service Unavailable')
  })
})
