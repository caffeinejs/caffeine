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

  // The members the renderer stamps, and the ones an agent branches on, mean one thing whoever set them.
  it('drops an extension named like a member an agent reads', () => {
    const problem = newProblem({
      status: 429,
      code: 'ERR_RATE_LIMITED',
      category: 'rate_limit',
      whatYouShouldDo: 'Wait 30 seconds',
      extensions: {
        category: 'forged',
        what_you_should_do: 'Retry forever',
        correlation_id: 'forged',
        timestamp: 'forged',
      },
    })

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too Many Requests',
      code: 'ERR_RATE_LIMITED',
      category: 'rate_limit',
      what_you_should_do: 'Wait 30 seconds',
    })
  })

  it('names a status Node has no phrase for generically', () => {
    expect(newProblem({ status: 499, code: 'ERR_CLIENT_GONE' }).title).toBe('Unknown Error')
  })

  // RFC 9457 §3.1.3: a title summarizes the kind of problem, which a `type` of its own can name better than a status.
  it('takes a title of its own over the status phrase, and the detail from it when there is none', () => {
    const problem = newProblem({ status: 422, code: 'ERR_CHECKOUT_REJECTED', title: 'Checkout rejected' })

    expect(problem.title).toBe('Checkout rejected')
    expect(problem.detail).toBe('Checkout rejected')
  })

  it('sends its entries as errors, in order', () => {
    const errors = [
      {
        code: 'ERR_ITEM_UNAVAILABLE',
        detail: 'Item 7 is sold out',
        source: { in: 'body' as const, pointer: '/items/0' },
      },
      { code: 'ERR_QUANTITY_LIMIT', detail: 'At most 3 of item 9', params: { maximum: 3 } },
    ]

    expect(newProblem({ status: 422, code: 'ERR_CHECKOUT_REJECTED', errors }).errors).toEqual(errors)
  })

  // An empty list would tell a client every entry is fine, which is not why the problem was sent.
  it('leaves out an empty list of entries', () => {
    expect(newProblem({ status: 422, code: 'ERR_CHECKOUT_REJECTED', errors: [] })).not.toHaveProperty('errors')
  })
})
