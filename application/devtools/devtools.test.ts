import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { DevTool, type DevToolOperation } from './devtools.js'
import { ErrDevToolInvalid, ErrDevToolNotFound } from './errors.js'

/**
 * A package contributes a tool by binding a subclass; the devtools find every one through the base class, so a tool
 * that does not extend it, or is not bound so, is never served.
 */
describe('DevTool', () => {
  @Injectable()
  class QueueTool extends DevTool {
    readonly id = 'queue'
    readonly title = 'Job queue'
    readonly description = 'Pending jobs'
    readonly operations = [{ method: 'GET', path: '/jobs', handle: () => ['a'] }] satisfies DevToolOperation[]
  }

  class CacheTool extends DevTool {
    get id(): string {
      return 'cache'
    }

    get title(): string {
      return 'Cache'
    }

    get description(): string {
      return 'Cached entries'
    }

    get operations(): DevToolOperation[] {
      return []
    }
  }

  it('is found through the base class, decorated or bound to extend it', async () => {
    const container = new CaffeineIoC()
    container.bind(CacheTool, t => t.toSelf().extends(DevTool))
    await container.init()

    expect(
      container
        .getManyOptional(DevTool)
        .map(tool => tool.id)
        .sort(),
    ).toEqual(['cache', 'queue'])
  })

  it('names what a tool refuses with a code the devtools map to a status', () => {
    expect(new ErrDevToolNotFound('No job "7"')).toMatchObject({
      name: 'ErrDevToolNotFound',
      code: 'ERR_DEVTOOL_NOT_FOUND',
      message: 'No job "7"',
    })
    expect(new ErrDevToolInvalid('Cannot cancel job "7": it has finished')).toMatchObject({
      name: 'ErrDevToolInvalid',
      code: 'ERR_DEVTOOL_INVALID',
    })
  })
})
