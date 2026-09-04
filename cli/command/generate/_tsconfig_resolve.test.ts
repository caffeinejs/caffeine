import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAliasResolver } from './_tsconfig_resolve.js'

describe('buildAliasResolver()', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true })
    }
  })

  async function project(files: Record<string, string>): Promise<string> {
    const dir = join(tmpdir(), `caffeine-test-${randomUUID()}`)
    dirs.push(dir)
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(dir, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await Bun.write(abs, text)
    }
    return dir
  }

  it('returns undefined when the file does not exist', async () => {
    const dir = await project({})
    expect(await buildAliasResolver(join(dir, 'tsconfig.json'))).toBeUndefined()
  })

  it('parses comments and a trailing comma', async () => {
    const dir = await project({
      'tsconfig.json': [
        '{',
        '  // line comment',
        '  "compilerOptions": {',
        '    /* block comment */',
        '    "baseUrl": ".",',
        '    "paths": { "@app/*": ["src/app/*"], },',
        '  },',
        '}',
      ].join('\n'),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/user.js')).toBe(join(dir, 'src/app/user.ts'))
  })

  it('matches an exact key without a wildcard', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@config': ['src/config.ts'] } } }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@config')).toBe(join(dir, 'src/config.ts'))
    expect(resolver?.resolve('@config/x')).toBeUndefined()
  })

  it('prefers the longest matching wildcard prefix', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['src/app/*'], '@app/admin/*': ['src/admin/*'] },
        },
      }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/admin/panel.js')).toBe(join(dir, 'src/admin/panel.ts'))
    expect(resolver?.resolve('@app/user.js')).toBe(join(dir, 'src/app/user.ts'))
  })

  it('an exact key outranks a wildcard key', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'], '@app/special': ['src/one-off.ts'] } },
      }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/special')).toBe(join(dir, 'src/one-off.ts'))
  })

  it('returns undefined for a specifier that matches no path', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@caffeinejs/di')).toBeUndefined()
  })

  it('inherits paths through an extends chain when a leaf omits them', async () => {
    const dir = await project({
      'base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './base.json' }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/user.js')).toBe(join(dir, 'src/app/user.ts'))
  })

  it('a leaf that sets paths fully replaces the parent, not merges', async () => {
    const dir = await project({
      'base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
      'tsconfig.json': JSON.stringify({
        extends: './base.json',
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@lib/util.js')).toBe(join(dir, 'src/lib/util.ts'))
    expect(resolver?.resolve('@app/user.js')).toBeUndefined()
  })

  it('walks a multi-level extends chain', async () => {
    const dir = await project({
      'root.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
      'mid.json': JSON.stringify({ extends: './root.json' }),
      'tsconfig.json': JSON.stringify({ extends: './mid.json' }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/user.js')).toBe(join(dir, 'src/app/user.ts'))
  })

  it('skips a non-relative extends target instead of erroring', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node20', compilerOptions: {} }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver).toBeUndefined()
  })

  it('throws on a cyclic extends chain', async () => {
    const dir = await project({
      'a.json': JSON.stringify({ extends: './b.json' }),
      'b.json': JSON.stringify({ extends: './a.json' }),
    })
    await expect(buildAliasResolver(join(dir, 'a.json'))).rejects.toThrow('extends cycle detected')
  })

  it('throws when an existing tsconfig cannot be parsed', async () => {
    const dir = await project({ 'tsconfig.json': '{ not json' })
    await expect(buildAliasResolver(join(dir, 'tsconfig.json'))).rejects.toThrow('Cannot parse tsconfig')
  })

  it('defaults baseUrl to the tsconfig directory when unset', async () => {
    const dir = await project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['src/app/*'] } } }),
    })
    const resolver = await buildAliasResolver(join(dir, 'tsconfig.json'))
    expect(resolver?.resolve('@app/user.js')).toBe(join(dir, 'src/app/user.ts'))
  })
})
