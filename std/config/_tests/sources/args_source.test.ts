import { describe, expect, it } from 'vitest'

import { ArgsConfigSource, type ArgsConfigSourceOptions } from '../../sources/args_source.js'

function parse(argv: string[], options: Omit<ArgsConfigSourceOptions, 'argv'> = {}): unknown {
  return new ArgsConfigSource({ ...options, argv }).load()[0].data
}

describe('ArgsConfigSource', () => {
  it('reads --key=value', () => {
    expect(parse(['--server.port=8080'])).toEqual({ server: { port: '8080' } })
  })

  it('reads --key value', () => {
    expect(parse(['--server.port', '8080'])).toEqual({ server: { port: '8080' } })
  })

  it('accepts a colon separator', () => {
    expect(parse(['--server:port=8080'])).toEqual({ server: { port: '8080' } })
  })

  it('reads a bare flag as true and a --no- prefix as false, as text', () => {
    expect(parse(['--health.verbose'])).toEqual({ health: { verbose: 'true' } })
    expect(parse(['--no-health.verbose'])).toEqual({ health: { verbose: 'false' } })
  })

  it('expands a mapped short switch, with a value or without one', () => {
    expect(parse(['-p', '8080'], { switchMappings: { '-p': 'server.port' } })).toEqual({ server: { port: '8080' } })
    expect(parse(['-v'], { switchMappings: { '-v': 'health.verbose' } })).toEqual({ health: { verbose: 'true' } })
  })

  it('ignores an unmapped short switch', () => {
    expect(parse(['-x', '--server.port=8080'])).toEqual({ server: { port: '8080' } })
  })

  it('stops at --, leaving the rest to the application', () => {
    expect(parse(['--server.port=8080', '--', '--server.host=nope'])).toEqual({ server: { port: '8080' } })
  })

  it('builds a list from indexed or bracketed keys', () => {
    expect(parse(['--tags.0=a', '--tags.1=b'])).toEqual({ tags: ['a', 'b'] })
    expect(parse(['--servers[0].host=h'])).toEqual({ servers: [{ host: 'h' }] })
  })

  it('parses process.argv, its slice, and Deno.args identically', () => {
    const expected = { server: { port: '8080' } }

    expect(parse(['/usr/bin/node', '/app/main.js', '--server.port=8080'])).toEqual(expected)
    expect(parse(['--server.port=8080'])).toEqual(expected)
    expect(parse(['./main', '--server.port=8080'])).toEqual(expected)
  })

  it('contributes nothing when there are no arguments', () => {
    expect(parse([])).toEqual({})
    expect(parse(['/usr/bin/node', '/app/main.js'])).toEqual({})
  })

  it('lets a later argument win over an earlier one for the same key', () => {
    expect(parse(['--server.port=8080', '--server.port=9090'])).toEqual({ server: { port: '9090' } })
  })

  it('records the argument each path came from', () => {
    expect(new ArgsConfigSource({ argv: ['--server.port=8080'] }).load()[0].origins?.get('server.port')).toBe(
      'args:--server.port=8080',
    )
  })

  it('falls back to the host arguments when none were given', () => {
    const original = process.argv
    process.argv = ['/usr/bin/node', '/app/main.js', '--server.port=7000']

    try {
      expect(new ArgsConfigSource().load()[0].data).toEqual({ server: { port: '7000' } })
      expect(new ArgsConfigSource({ argv: ['--server.port=8080'] }).load()[0].data).toEqual({
        server: { port: '8080' },
      })
    } finally {
      process.argv = original
    }
  })

  it('contributes nothing where there is no host command line', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!
    // @ts-expect-error - deleting a global the runtime declares as always present
    delete globalThis.process

    try {
      expect(new ArgsConfigSource().load()[0].data).toEqual({})
    } finally {
      Object.defineProperty(globalThis, 'process', descriptor)
    }
  })
})
