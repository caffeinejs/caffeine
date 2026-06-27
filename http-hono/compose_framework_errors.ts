import { Context, ErrorHandler } from 'hono'

export type FrameworkErrorHandler = ErrorHandler

export function composeFrameworkErrors(
  ...handlers: FrameworkErrorHandler[]
): FrameworkErrorHandler {
  return async (error, c) => {
    for (const handler of handlers) {
      const result = await handler(error, c)
      if (result) {
        return result
      }
    }

    throw error
  }
}

export type { Context as HonoErrorContext }
