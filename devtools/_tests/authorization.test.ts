import type { WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import type { DevToolsBuilder, DevToolsIndex } from '../index.js'
import { OPERATOR, PROTECTED, VIEWER, capturingLogger, get, target } from './fixtures.js'

const WARNING = 'DevTools is served without authorization while authentication is configured'

describe('DevTools authorization', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // What DevTools exposes is the application's inside: no slice may answer around what `authorize(...)` declared.
  it('requires what authorize(...) declares, on the index and on every slice it lists', async () => {
    app = target({ basic: true, devtools: d => d.authorize(PROTECTED) })
    await app.bootstrap()

    expect((await get(app, '/devtools')).status).toBe(401)
    expect((await get(app, '/devtools', VIEWER)).status).toBe(403)

    const index = (await (await get(app, '/devtools', OPERATOR)).json()) as DevToolsIndex

    expect(index.slices).toHaveLength(6)

    for (const { href } of index.slices) {
      expect((await get(app, href)).status, href).toBe(401)
      expect((await get(app, href, VIEWER)).status, href).toBe(403)
      expect((await get(app, href, OPERATOR)).status, href).toBe(200)
    }
  })

  // Without a gate on its own server, a protected route would never authenticate: start-up refuses it rather
  // than serve DevTools to no one, or, worse, think it was protected.
  it('refuses to start when no gate on its server authenticates', async () => {
    app = target({ basic: true, gate: false, devtools: d => d.authorize(PROTECTED) })

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTHENTICATION_GATE_REQUIRED' })
  })

  describe('the warning written at start-up', () => {
    it.each<[string, (d: DevToolsBuilder) => DevToolsBuilder, number]>([
      ['once, with authentication configured, when DevTools declares nothing', d => d, 1],
      ['never when DevTools is declared public()', d => d.public(), 0],
      ['never when DevTools requires authorize(...)', d => d.authorize(PROTECTED), 0],
    ])('is written %s', async (_, configure, expected) => {
      const { logger, warnings } = capturingLogger()

      app = target({ basic: true, logger, devtools: configure })
      await app.bootstrap()

      expect(warnings.filter(warning => warning.startsWith(WARNING))).toHaveLength(expected)
    })

    it('is not written when no authentication is configured', async () => {
      const { logger, warnings } = capturingLogger()

      app = target({ logger })
      await app.bootstrap()

      expect(warnings.filter(warning => warning.startsWith(WARNING))).toEqual([])
    })
  })
})
