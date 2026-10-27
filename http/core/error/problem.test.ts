import { describe, expect, it } from 'vitest'

import { newProblem } from './problem.js'

describe('newProblem', () => {
  // RFC 9457 §4.2.1: with no type of its own, a problem means what its status means, and says so in its title.
  it('defaults the type to about:blank and the detail to the status phrase', () => {
    expect(newProblem({ status: 404, code: 'ERR_PET_NOT_FOUND' })).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Not Found',
      code: 'ERR_PET_NOT_FOUND',
    })
  })

  it('keeps an extension beside the members it defines, and never over one', () => {
    const problem = newProblem({
      status: 409,
      code: 'ERR_ORDER_PAID',
      detail: 'Order 42 is already paid',
      instance: '/orders/42',
      extensions: { orderID: '42', status: 200, code: 'forged', errors: [], stacktrace: 'forged' },
    })

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Order 42 is already paid',
      code: 'ERR_ORDER_PAID',
      instance: '/orders/42',
      orderID: '42',
    })
  })

  it('names a status Node has no phrase for generically', () => {
    expect(newProblem({ status: 499, code: 'ERR_CLIENT_GONE' }).title).toBe('Unknown Error')
  })
})
