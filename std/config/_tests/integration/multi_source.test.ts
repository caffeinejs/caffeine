import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bootstrapConfig } from '../../bootstrap.js'
import { EnvProvider } from '../../providers/env_provider.js'
import { FileProvider } from '../../providers/file_provider.js'
import { InlineProvider } from '../../providers/inline_provider.js'
import '../../providers/yaml_parser.js'
import type { ConfigProvider, ResolutionContext } from '../../types.js'

// `server` is present in every scenario below. `db` and `app` may be absent from all sources, so they carry an
// explicit object default — this is what the "missing everywhere" case (schema default, no source origin) tests.
const schema = z.object({
  server: z.object({ port: z.coerce.number(), host: z.string() }),
  db: z.object({ url: z.string() }).default({ url: '' }),
  app: z.object({ name: z.string() }).default({ name: 'default-app' }),
})

const tmp: string[] = []

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, content, 'utf8')
  tmp.push(path)
  return path
}

afterEach(async () => {
  for (const f of tmp.splice(0)) {
    await unlink(f).catch(() => undefined)
  }
})

describe('config multi-source precedence & provenance', () => {
  // server.host: in env + file + inline. server.port: in file + inline. db.url: inline only. app.name: nowhere.
  async function providers(): Promise<{ env: ConfigProvider, file: ConfigProvider, inline: ConfigProvider }> {
    const filePath = await writeTmp('multi-source.json', JSON.stringify({ server: { port: 8080, host: 'file-host' } }))
    return {
      env: new EnvProvider({ prefix: 'APP_' }),
      file: new FileProvider(filePath),
      inline: new InlineProvider({ server: { port: 3000, host: 'inline-host' }, db: { url: 'inline-url' } }),
    }
  }

  const env = { APP_SERVER__HOST: 'env-host' }

  it('resolves each key from its highest-precedence source (env > file > inline)', async () => {
    const p = await providers()
    const ctx: ResolutionContext = { app: 'test', profiles: ['default'], env }

    const { config, diagnostics } = await bootstrapConfig({
      providers: [p.env, p.file, p.inline],
      schema,
      context: ctx,
    })

    // present in all three -> env wins
    expect(config.server.host).toBe('env-host')
    expect(diagnostics.originOf('server.host')).toMatch(/^env:/)

    // present in file + inline -> file wins
    expect(config.server.port).toBe(8080)
    expect(diagnostics.originOf('server.port')).toMatch(/^file:/)

    // inline only
    expect(config.db.url).toBe('inline-url')
    expect(diagnostics.originOf('db.url')).toMatch(/^inline/)

    // missing everywhere -> schema default, no origin
    expect(config.app.name).toBe('default-app')
    expect(diagnostics.originOf('app.name')).toBeUndefined()
  })

  it('reordering providers changes the winning source (first wins)', async () => {
    const p = await providers()
    const ctx: ResolutionContext = { app: 'test', profiles: ['default'], env }

    const { config, diagnostics } = await bootstrapConfig({
      providers: [p.inline, p.file, p.env],
      schema,
      context: ctx,
    })

    expect(config.server.host).toBe('inline-host')
    expect(diagnostics.originOf('server.host')).toMatch(/^inline/)
    expect(config.server.port).toBe(3000)
    expect(diagnostics.originOf('server.port')).toMatch(/^inline/)
  })

  it('loads a YAML source (parser registered via import side effect)', async () => {
    const yamlPath = await writeTmp('multi-source.yaml', 'server:\n  host: yaml-host\n  port: 9090\n')
    const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }

    const { config, diagnostics } = await bootstrapConfig({
      providers: [new FileProvider(yamlPath)],
      schema,
      context: ctx,
    })

    expect(config.server.host).toBe('yaml-host')
    expect(config.server.port).toBe(9090)
    expect(diagnostics.originOf('server.host')).toMatch(/^file:/)
  })
})
