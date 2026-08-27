import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { scaffold } from './scaffolder.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'caffeine-scaffold-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('scaffold()', () => {
  test('copies files preserving directory structure', async () => {
    const templateDir = join(tmpDir, 'tpl-copy')
    await mkdir(join(templateDir, 'src'), { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app', version: '0.0.0' }))
    await writeFile(join(templateDir, 'src', 'main.ts'), 'console.log("hello")\n')

    const outDir = join(tmpDir, 'out-copy')
    await scaffold({ templateDir, outDir, projectName: 'test-project', agentsMd: false })

    const main = await readFile(join(outDir, 'src', 'main.ts'), 'utf-8')
    expect(main).toBe('console.log("hello")\n')
  })

  test('injects projectName into package.json', async () => {
    const templateDir = join(tmpDir, 'tpl-pkg')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app', version: '1.2.3', type: 'module' }))

    const outDir = join(tmpDir, 'out-pkg')
    await scaffold({ templateDir, outDir, projectName: 'my-real-project', agentsMd: false })

    const pkg = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf-8')) as Record<string, unknown>
    expect(pkg.name).toBe('my-real-project')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.type).toBe('module')
  })

  test('copies non-package.json files verbatim', async () => {
    const templateDir = join(tmpDir, 'tpl-verbatim')
    await mkdir(templateDir, { recursive: true })
    const content = 'export const x = 1\n'
    await writeFile(join(templateDir, 'index.ts'), content)
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app' }))

    const outDir = join(tmpDir, 'out-verbatim')
    await scaffold({ templateDir, outDir, projectName: 'proj', agentsMd: false })

    const copied = await readFile(join(outDir, 'index.ts'), 'utf-8')
    expect(copied).toBe(content)
  })
})

async function writeMiniAi(aiDir: string): Promise<void> {
  await mkdir(join(aiDir, 'templates'), { recursive: true })
  await mkdir(join(aiDir, 'skills', 'caffeine-http-controller'), { recursive: true })
  await mkdir(join(aiDir, 'skills', 'caffeine-error-handlers'), { recursive: true })
  await mkdir(join(aiDir, 'skills', 'caffeine-kafka-listener'), { recursive: true })
  await writeFile(join(aiDir, 'llms.txt'), '# Caffeine\n')
  await writeFile(
    join(aiDir, 'templates', 'AGENTS.md'),
    '<!-- BEGIN:caffeine-agent-rules -->\nrules\n<!-- END:caffeine-agent-rules -->\n',
  )
  await writeFile(join(aiDir, 'templates', 'CLAUDE.md'), '@AGENTS.md\n')
  await writeFile(join(aiDir, 'skills', 'caffeine-http-controller', 'SKILL.md'), '# http\n')
  await writeFile(join(aiDir, 'skills', 'caffeine-error-handlers', 'SKILL.md'), '# errors\n')
  await writeFile(join(aiDir, 'skills', 'caffeine-kafka-listener', 'SKILL.md'), '# kafka\n')
}

describe('scaffold() agent files', () => {
  test('copies AGENTS.md, CLAUDE.md, and skills from aiDir', async () => {
    const templateDir = join(tmpDir, 'tpl-agents')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app' }))

    const aiDir = join(tmpDir, 'ai-pack')
    await writeMiniAi(aiDir)

    const outDir = join(tmpDir, 'out-agents')
    await scaffold({ templateDir, outDir, projectName: 'with-agents', aiDir })

    const agents = await readFile(join(outDir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('BEGIN:caffeine-agent-rules')
    expect(await readFile(join(outDir, 'CLAUDE.md'), 'utf-8')).toBe('@AGENTS.md\n')
    expect(await readFile(join(outDir, '.agents', 'skills', 'caffeine-http-controller', 'SKILL.md'), 'utf-8'))
      .toBe('# http\n')
    expect(await readFile(join(outDir, '.agents', 'skills', 'caffeine-error-handlers', 'SKILL.md'), 'utf-8'))
      .toBe('# errors\n')
    expect(await readFile(join(outDir, '.agents', 'skills', 'caffeine-kafka-listener', 'SKILL.md'), 'utf-8'))
      .toBe('# kafka\n')
  })

  test('agentsMd: false writes no agent files', async () => {
    const templateDir = join(tmpDir, 'tpl-no-agents')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app' }))

    const aiDir = join(tmpDir, 'ai-pack-skipped')
    await writeMiniAi(aiDir)

    const outDir = join(tmpDir, 'out-no-agents')
    await scaffold({ templateDir, outDir, projectName: 'no-agents', aiDir, agentsMd: false })

    await expect(readFile(join(outDir, 'AGENTS.md'))).rejects.toThrow()
    await expect(readFile(join(outDir, 'CLAUDE.md'))).rejects.toThrow()
    await expect(readFile(join(outDir, '.agents', 'skills', 'caffeine-http-controller', 'SKILL.md'))).rejects.toThrow()
  })
})
