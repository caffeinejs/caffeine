import { describe, expect, it } from 'vitest'
import { MutableConfigProvider } from '../../providers/mutable_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

async function entriesOf(provider: MutableConfigProvider): Promise<Record<string, unknown>> {
  const [source] = await provider.load(ctx)
  return Object.fromEntries([...source.entries].map(([k, e]) => [k, e.value]))
}

describe('MutableConfigProvider', () => {
  it('treats a dotted path and a pre-split one as the same key', async () => {
    const dotted = new MutableConfigProvider().set('server.port', 3000)
    const split = new MutableConfigProvider().set(['server', 'port'], 3000)

    expect(await entriesOf(dotted)).toEqual({ 'server.port': 3000 })
    expect(await entriesOf(split)).toEqual(await entriesOf(dotted))
  })

  it('flattens an object value to its leaves so it merges rather than replaces', async () => {
    const provider = new MutableConfigProvider().set('server', { port: 3000, host: '0.0.0.0' })

    expect(await entriesOf(provider)).toEqual({
      'server.port': 3000,
      'server.host': '0.0.0.0',
    })
  })

  it('keeps an empty array addressable', async () => {
    const provider = new MutableConfigProvider().set('health.signals', [])
    expect(await entriesOf(provider)).toEqual({ 'health.signals': [] })
  })

  it('indexes a non-empty array', async () => {
    const provider = new MutableConfigProvider().set('health.signals', ['SIGTERM', 'SIGINT'])

    expect(await entriesOf(provider)).toEqual({
      'health.signals.0': 'SIGTERM',
      'health.signals.1': 'SIGINT',
    })
  })

  it('replaces a subtree rather than merging into it on a second set', async () => {
    const provider = new MutableConfigProvider()
      .set('server', { port: 3000, host: '0.0.0.0' })
      .set('server', { port: 8080 })

    expect(await entriesOf(provider)).toEqual({ 'server.port': 8080 })
  })

  it('merges leaves from the root', async () => {
    const provider = new MutableConfigProvider()
      .set('server.port', 3000)
      .merge({ server: { host: '127.0.0.1' } })

    expect(await entriesOf(provider)).toEqual({ 'server.port': 3000, 'server.host': '127.0.0.1' })
  })

  it('unsets a leaf and everything beneath a branch', async () => {
    const provider = new MutableConfigProvider()
      .set('server.port', 3000)
      .set('server.host', '0.0.0.0')
      .set('health.verbose', true)

    provider.unset('server')
    expect(await entriesOf(provider)).toEqual({ 'health.verbose': true })

    provider.unset('health.verbose')
    expect(provider.empty).toBe(true)
  })

  it('does not unset a sibling that merely shares a prefix', async () => {
    const provider = new MutableConfigProvider()
      .set('server.port', 3000)
      .set('serverless.port', 1)

    provider.unset('server')
    expect(await entriesOf(provider)).toEqual({ 'serverless.port': 1 })
  })

  it('discards everything on replace', async () => {
    const provider = new MutableConfigProvider().set('server.port', 3000)
    provider.replace({ health: { verbose: true } })

    expect(await entriesOf(provider)).toEqual({ 'health.verbose': true })
  })

  it('hands each load its own snapshot, so a later write cannot shift one in flight', async () => {
    const provider = new MutableConfigProvider().set('server.port', 3000)
    const [source] = await provider.load(ctx)

    provider.set('server.port', 8080)

    expect(source.entries.get('server.port')?.value).toBe(3000)
    expect(await entriesOf(provider)).toEqual({ 'server.port': 8080 })
  })

  it('escapes a literal dot inside a segment so it stays one key', async () => {
    const provider = new MutableConfigProvider().set(['logging', 'com.acme'], 'debug')
    expect(Object.keys(await entriesOf(provider))).toEqual(['logging.com\\.acme'])
  })
})
