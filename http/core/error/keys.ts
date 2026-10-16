import { token } from '@caffeinejs/di'

import type { GlobalErrorHandlerOptions } from './error.js'

export const kErrorHandlingOptions = token<Required<GlobalErrorHandlerOptions>>(
  Symbol('caffeine:http:error-handling-options'),
)
