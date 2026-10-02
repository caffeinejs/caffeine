import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { boundTo } from '../../binding.js'
import { bindTo } from '../../decorators/bind_to.js'
import { stateOf } from './_state.js'
import { flattenRouter } from './flatten.js'
import { Router } from './router.js'

describe('default route names', () => {
  it('ignores long malformed constraints without retrying at every parenthesis', () => {
    const router = new Router('/pets').get('/:id' + '('.repeat(100_000) + '\nx', () => undefined)
    const started = performance.now()
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].spec.routes[0].name).toBe('get_id')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('keeps parameter, optional and wildcard names stable', () => {
    const router = new Router('/pets')
      .get('/:id(^\\d+$)', () => undefined)
      .post('/:name?', () => undefined)
      .delete('/*', () => undefined)
    const groups = flattenRouter(stateOf(router)!, new CaffeineIoC())
    expect(groups[0].name).toBe('Pets')
    expect(groups[0].spec.routes.map(route => route.name)).toEqual(['get_id', 'post_name', 'delete_all'])
  })
})

/**
 * A router tree has one binding: a nested router is served where the router it is nested in is, and saying otherwise
 * is refused rather than silently dropped by the merge.
 */
describe('binding a nested router', () => {
  const bindings = (router: object) =>
    flattenRouter(stateOf(router)!, new CaffeineIoC()).map(group => [group.name, boundTo(group.spec.labels)])

  it('serves a nested router where its parent is', () => {
    const ops = new Router('/ops').with(bindTo('admin')).group('/jobs', jobs => jobs.get('/', () => undefined))

    expect(bindings(ops)).toEqual([['OpsJobs', 'admin']])
  })

  it('accepts a nested router repeating its parent binding', () => {
    const ops = new Router('/ops')
      .with(bindTo('admin'))
      .group('/jobs', jobs => jobs.with(bindTo('admin')).get('/', () => undefined))

    expect(bindings(ops)).toEqual([['OpsJobs', 'admin']])
  })

  it('refuses a nested router bound to another server, naming both routers', () => {
    const ops = new Router('/ops')
      .with(bindTo('admin'))
      .get('/', () => undefined)
      .group('/jobs', jobs => jobs.with(bindTo('metrics')).get('/', () => undefined))

    expect(() => bindings(ops)).toThrow(
      /^Cannot nest router "OpsJobs" in "Ops": it is bound to "metrics", and "Ops" to "admin"/,
    )
  })

  it('lets a router nested in an unbound router bind itself', () => {
    const api = new Router('/api')
      .get('/', () => undefined)
      .group('/ops', ops => ops.with(bindTo('admin')).get('/', () => undefined))

    expect(bindings(api)).toEqual([
      ['Api', undefined],
      ['ApiOps', 'admin'],
    ])
  })

  it('serves a router shared by a bound and an unbound parent in each place it lands', () => {
    const shared = new Router('/shared').get('/', () => undefined)
    const ops = new Router('/ops').with(bindTo('admin')).mount(shared)
    const api = new Router('/api').mount(shared)

    expect(bindings(ops)).toEqual([['OpsShared', 'admin']])
    expect(bindings(api)).toEqual([['ApiShared', undefined]])
  })
})
