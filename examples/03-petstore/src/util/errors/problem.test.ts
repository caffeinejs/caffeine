import { describe, it, expect } from 'vitest'
import { problemFor } from './problem.js'

// Pure unit — no app, no container. The RFC 9457 body builder.
describe('problemFor', () => {
  it('maps a known status to its spec type URI and title', () => {
    expect(problemFor(404)).toEqual({
      type: 'https://petstoreapi.com/errors/not-found',
      title: 'Not Found',
      status: 404,
    })
  })

  it('falls back to about:blank for an unmapped status', () => {
    expect(problemFor(418)).toEqual({ type: 'about:blank', title: 'Error', status: 418 })
  })

  it('includes detail, instance and errors when provided', () => {
    const problem = problemFor(422, 'Validation failed', {
      instance: '/pets',
      errors: [{ field: 'name', message: 'Pet name is required', code: 'required' }],
    })

    expect(problem).toEqual({
      type: 'https://petstoreapi.com/errors/validation-error',
      title: 'Validation Error',
      status: 422,
      detail: 'Validation failed',
      instance: '/pets',
      errors: [{ field: 'name', message: 'Pet name is required', code: 'required' }],
    })
  })

  it('omits optional members when absent', () => {
    const problem = problemFor(500)
    expect(problem).not.toHaveProperty('detail')
    expect(problem).not.toHaveProperty('instance')
    expect(problem).not.toHaveProperty('errors')
  })
})
