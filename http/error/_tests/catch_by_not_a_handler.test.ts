import { Injectable, Named, token } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import { CatchWith, Controller, ErrConfiguration, ErrorHandler, Get, createWebApplication } from '../../index.js'

// Isolated: the invalid reference poisons every app build in its module, so it must be the only
// error-handler concern in this file. Referencing by name is the only way to reach this check —
// passing a class that is not an ErrorHandler does not type-check.
@Named('notAHandler')
@Injectable()
class NotAHandler {}
void [NotAHandler]

@CatchWith(token<ErrorHandler<Error>>('notAHandler'))
@Controller('/undeclared')
class UndeclaredController {
  @Get('/')
  boom(): unknown {
    throw new Error('boom')
  }
}
void [UndeclaredController]

describe('@CatchWith with a binding that is not an error handler', () => {
  it('rejects when the referenced binding is not decorated with @Catch', async () => {
    const app = createWebApplication()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
