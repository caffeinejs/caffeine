import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConsoleLogger } from './console/console.js'
import { Log } from './log.js'

/** Restores the process-wide logger between tests — `Log` is a static singleton, so leaking it would make
 *  tests order-dependent. */
function restore() {
  Log.use(new ConsoleLogger())
}

afterEach(() => {
  vi.restoreAllMocks()
  restore()
})

describe('Log', () => {
  // The same default `LoggerBuilder` falls back to, so the two entry points into logging agree on how verbose a
  // process is before anything configures one.
  it('is an info-level ConsoleLogger before .use() is ever called', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    Log.for('bare').info('reaches console before .use()')
    Log.for('bare').debug('below the default level')

    expect(info).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('derives children from whatever .use() set', () => {
    const provided = new ConsoleLogger({ level: 'warn' })
    Log.use(provided)

    expect(Log.for('x').level).toBe('warn')
  })

  it('names the child from a plain string', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    Log.use(new ConsoleLogger())

    Log.for('CatalogService').info('hit')

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ name: 'CatalogService' })
  })

  // The point of taking a class reference at all: no string literal to keep in sync with the class name.
  it('names the child from a class reference, using its own .name', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    Log.use(new ConsoleLogger())

    class CatalogService {}
    Log.for(CatalogService).info('hit')

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ name: 'CatalogService' })
  })

  it('merges additional bindings alongside the derived name', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    Log.use(new ConsoleLogger())

    Log.for('X', { module: 'orders' }).info('hit')

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ name: 'X', module: 'orders' })
  })

  // A name given explicitly through bindings is what the caller meant, over whatever was derived.
  it('lets bindings override the derived name', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    Log.use(new ConsoleLogger())

    Log.for('X', { name: 'Y' }).info('hit')

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ name: 'Y' })
  })

  it('forwards options to child(), same as Logger.child would take them', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    Log.use(new ConsoleLogger({ level: 'warn' }))

    const child = Log.for('X', undefined, { level: 'debug' })
    child.debug('now visible')

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
