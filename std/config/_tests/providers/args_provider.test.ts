import { describe, expect, it } from 'vitest'
import { ArgsConfigProvider } from '../../providers/args_provider.js'
import { EnvConfigProvider } from '../../providers/env_provider.js'
import type { ArgsConfigProviderOptions } from '../../providers/args_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

async function parse(argv: string[], options: Omit<ArgsConfigProviderOptions, 'argv'> = {}): Promise<Record<string, unknown>> {
  const [source] = await new ArgsConfigProvider({ ...options, argv }).load(ctx)
  return Object.fromEntries([...source.entries].map(([k, e]) => [k, e.value]))
}

describe('ArgsConfigProvider', () => {
  it('reads --key=value', async () => {
    expect(await parse(['--server.port=8080'])).toEqual({ 'server.port': 8080 })
  })

  it('reads --key value', async () => {
    expect(await parse(['--server.port', '8080'])).toEqual({ 'server.port': 8080 })
  })

  it('accepts a colon separator', async () => {
    expect(await parse(['--server:port=8080'])).toEqual({ 'server.port': 8080 })
  })

  it('treats a bare flag as true', async () => {
    expect(await parse(['--health.verbose'])).toEqual({ 'health.verbose': true })
  })

  it('treats a --no- prefix as false', async () => {
    expect(await parse(['--no-health.verbose'])).toEqual({ 'health.verbose': false })
  })

  it('expands a mapped short switch with a value', async () => {
    const mapped = await parse(['-p', '8080'], { switchMappings: { '-p': 'server.port' } })
    expect(mapped).toEqual({ 'server.port': 8080 })
  })

  it('expands a mapped short switch with no value as true', async () => {
    const mapped = await parse(['-v'], { switchMappings: { '-v': 'health.verbose' } })
    expect(mapped).toEqual({ 'health.verbose': true })
  })

  it('ignores an unmapped short switch', async () => {
    expect(await parse(['-x', '--server.port=8080'])).toEqual({ 'server.port': 8080 })
  })

  it('stops at --, leaving the rest to the application', async () => {
    expect(await parse(['--server.port=8080', '--', '--server.host=nope']))
      .toEqual({ 'server.port': 8080 })
  })

  it('parses process.argv, its slice, and Deno.args identically', async () => {
    const expected = { 'server.port': 8080 }

    expect(await parse(['/usr/bin/node', '/app/main.js', '--server.port=8080'])).toEqual(expected)
    expect(await parse(['--server.port=8080'])).toEqual(expected)
    expect(await parse(['./main', '--server.port=8080'])).toEqual(expected)
  })

  it('contributes nothing when there are no arguments', async () => {
    expect(await parse([])).toEqual({})
    expect(await parse(['/usr/bin/node', '/app/main.js'])).toEqual({})
  })

  it('takes argv from the resolution context when none was configured', async () => {
    const [source] = await new ArgsConfigProvider().load({ ...ctx, argv: ['--server.port=7000'] })
    expect(source.entries.get('server.port')?.value).toBe(7000)
  })

  it('contributes nothing when neither the options nor the context carry argv', async () => {
    const [source] = await new ArgsConfigProvider().load(ctx)
    expect(source.entries.size).toBe(0)
  })

  it('coerces exactly as the environment provider does', async () => {
    const cases = ['true', '1', 'yes', 'on', 'false', '0', 'no', 'off', '8080', '1.5', 'hello', '']
    const env = new EnvConfigProvider()

    for (const raw of cases) {
      const [envSource] = await env.load({ ...ctx, env: { KEY: raw } })
      const args = await parse([`--key=${raw}`])

      expect(args.key, `"${raw}" must coerce the same from both sources`)
        .toEqual(envSource.entries.get('key')?.value)
    }
  })

  it('records the originating argument as the entry origin', async () => {
    const [source] = await new ArgsConfigProvider({ argv: ['--server.port=8080'] }).load(ctx)
    expect(source.entries.get('server.port')?.origin).toBe('args:--server.port=8080')
  })

  it('lets a later argument win over an earlier one for the same key', async () => {
    expect(await parse(['--server.port=8080', '--server.port=9090'])).toEqual({ 'server.port': 9090 })
  })
})
