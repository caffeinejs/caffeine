import { describe, expect, it } from 'vitest'

import { ErrCaffeineWebApplication } from '../../../core/error/common.js'
import { GlobalErrorHandlerRef } from './error.js'

describe('GlobalErrorHandlerRef', () => {
  // A route group's handler falls back to the global one; reading it before the plugin ran is a wiring bug in the
  // adapter, and it must fail loudly rather than hand back `undefined`.
  it('refuses a read before the error handling plugin registered', () => {
    const ref = new GlobalErrorHandlerRef()

    expect(() => ref.handler).toThrow(ErrCaffeineWebApplication)
    expect(() => ref.handler).toThrow(
      expect.objectContaining({
        code: 'ERR_ERROR_HANDLER_NOT_INSTALLED',
        message: expect.stringMatching(
          /^Cannot read the global error handler: the error handling plugin has not registered yet/,
        ),
      }),
    )
  })

  it('hands back the handler the plugin installed', () => {
    const ref = new GlobalErrorHandlerRef()
    const handler = async () => undefined

    ref.handler = handler

    expect(ref.handler).toBe(handler)
  })
})
