import { describe, expect, it } from 'vitest'

import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Header } from '../decorators/params/header.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
import { QueryName } from '../decorators/params/query_name.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { Params } from '../decorators/params.js'
import { GET, POST } from '../decorators/verbs.js'
import { allMethodMeta } from '../metadata.js'
import { noop } from '../noop.js'

function metadataOf(ctor: Function): DecoratorMetadataObject {
  return (ctor as unknown as { [Symbol.metadata]: DecoratorMetadataObject })[Symbol.metadata]
}

describe('@Params', () => {
  it('records every parameter descriptor in declaration order', () => {
    class Api {
      @GET('/users/{id}')
      @Params([Param('id'), Query('active'), QueryName(), Header('x-trace'), SignalParam()])
      get(
        _id: string,
        _active: boolean,
        _flag: unknown,
        _trace: string,
        _signal: AbortSignal,
      ): Promise<unknown> {
        return noop()
      }
    }

    const method = allMethodMeta(metadataOf(Api)).get('get')

    expect(method?.params).toEqual([
      { kind: 'path', key: 'id', index: 0 },
      { kind: 'query', key: 'active', index: 1 },
      { kind: 'query-name', index: 2 },
      { kind: 'header', key: 'x-trace', index: 3 },
      { kind: 'signal', index: 4 },
    ])
    expect(method?.argLen).toBe(5)
  })

  it('@Body records the body index', () => {
    class Api {
      @POST('/users')
      @Params([Body()])
      create(_body: unknown): Promise<unknown> {
        return noop()
      }
    }

    const method = allMethodMeta(metadataOf(Api)).get('create')

    expect(method?.params).toEqual([{ kind: 'body', index: 0 }])
    expect(method?.bodyIndex).toBe(0)
  })

  it('@Field records form-field descriptors', () => {
    class Api {
      @POST('/form')
      @Params([Field('name'), Field('age')])
      submit(_name: string, _age: number): Promise<unknown> {
        return noop()
      }
    }

    const method = allMethodMeta(metadataOf(Api)).get('submit')

    expect(method?.params).toEqual([
      { kind: 'form-field', key: 'name', index: 0 },
      { kind: 'form-field', key: 'age', index: 1 },
    ])
  })

  it('does not affect decorator evaluation order relative to the verb decorator', () => {
    // @Params below @GET or above should be equivalent, since both write into the same
    // shared context.metadata object rather than composing return values.
    class Below {
      @GET('/x')
      @Params([Param('id')])
      get(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const method = allMethodMeta(metadataOf(Below)).get('get')

    expect(method?.httpMethod).toBe('GET')
    expect(method?.params).toEqual([{ kind: 'path', key: 'id', index: 0 }])
  })
})
