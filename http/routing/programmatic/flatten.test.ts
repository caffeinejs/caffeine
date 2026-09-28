import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

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
