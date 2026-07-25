import { describe, expect, it } from 'vitest'

import { Body } from '../decorators/params/body.js'
import { Field } from '../decorators/params/field.js'
import { Header } from '../decorators/params/header.js'
import { Param } from '../decorators/params/param.js'
import { Query } from '../decorators/params/query.js'
import { QueryName } from '../decorators/params/query_name.js'
import { SignalParam } from '../decorators/params/signal_param.js'
import { Params } from '../decorators/params.js'
import { getMethodBuilders } from '../decorators/registrar/registrar.js'
import { GET, POST } from '../decorators/verbs.js'
import { noop } from '../noop.js'
import { captureMetadata } from './capture_metadata.js'

describe('@Params', () => {
  it('records every parameter descriptor in declaration order', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
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

    const spec = getMethodBuilders(metadata()).get('get')?.toMethodSpec()

    expect(spec?.params).toEqual([
      { kind: 'path', key: 'id', index: 0 },
      { kind: 'query', key: 'active', index: 1 },
      { kind: 'query-name', index: 2 },
      { kind: 'header', key: 'x-trace', index: 3 },
      { kind: 'signal', index: 4 },
    ])
  })

  it('@Body records the body index', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
      @POST('/users')
      @Params([Body()])
      create(_body: unknown): Promise<unknown> {
        return noop()
      }
    }

    const spec = getMethodBuilders(metadata()).get('create')?.toMethodSpec()

    expect(spec?.params).toEqual([{ kind: 'body', index: 0 }])
  })

  it('@Field records form-field descriptors', () => {
    const { capture, metadata } = captureMetadata()

    @capture
    class API {
      @POST('/form')
      @Params([Field('name'), Field('age')])
      submit(_name: string, _age: number): Promise<unknown> {
        return noop()
      }
    }

    const spec = getMethodBuilders(metadata()).get('submit')?.toMethodSpec()

    expect(spec?.params).toEqual([
      { kind: 'form-field', key: 'name', index: 0 },
      { kind: 'form-field', key: 'age', index: 1 },
    ])
  })

  it('does not affect decorator evaluation order relative to the verb decorator', () => {
    // @Params below @GET or above should be equivalent, since both write into the same
    // shared context.metadata-keyed registrar entry rather than composing return values.
    const { capture, metadata } = captureMetadata()

    @capture
    class Below {
      @GET('/x')
      @Params([Param('id')])
      get(_id: string): Promise<unknown> {
        return noop()
      }
    }

    const spec = getMethodBuilders(metadata()).get('get')?.toMethodSpec()

    expect(spec?.httpMethod).toBe('GET')
    expect(spec?.params).toEqual([{ kind: 'path', key: 'id', index: 0 }])
  })
})
