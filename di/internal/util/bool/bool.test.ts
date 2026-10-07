import { describe, it, expect } from 'vitest'

import { parseBool } from './bool.js'

describe('parseBool', function () {
  it('should read 1, t, true, on and yes as true, in any letter case', function () {
    for (const value of ['1', 't', 'T', 'true', 'TRUE', 'True', 'tRuE', 'on', 'On', 'ON', 'yes', 'YES', 'yEs']) {
      expect(parseBool(value), value).toBe(true)
    }
  })

  it('should read 0, f, false, off and no as false, in any letter case', function () {
    for (const value of ['0', 'f', 'F', 'false', 'FALSE', 'False', 'fAlSe', 'off', 'Off', 'OFF', 'no', 'NO', 'nO']) {
      expect(parseBool(value), value).toBe(false)
    }
  })

  it('should read anything else as no boolean at all, so a typo is never taken for false', function () {
    for (const value of ['', ' ', ' true', 'true ', '2', '-1', 'y', 'n', 'enabled', 'truee', 'nope']) {
      expect(parseBool(value), JSON.stringify(value)).toBeUndefined()
    }
  })
})
