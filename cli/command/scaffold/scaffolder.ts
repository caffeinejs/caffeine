import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ScaffoldContext {
  templateDir: string
  outDir: string
  projectName: string
  /** When false, skip AGENTS.md, CLAUDE.md, and `.agents/skills/`. Defaults to true. */
  agentsMd?: boolean
  /** Agent pack root (`ai/`). Tests pass this; the CLI resolves it by walking up to `ai/llms.txt`. */
  aiDir?: string
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else {
      files.push(full)
    }
  }
  return files
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  )
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
  const files = await walk(srcDir)
  for (const src of files) {
    const rel = src.slice(srcDir.length + 1)
    const dest = join(destDir, rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }
}

/** Walks from `start` toward the filesystem root until `ai/llms.txt` exists. */
export async function findAiDir(start: string): Promise<string | undefined> {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'ai')
    if (await exists(join(candidate, 'llms.txt'))) {
      return candidate
    }

    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }

    dir = parent
  }
}

async function copyAgentFiles(outDir: string, aiDir: string): Promise<void> {
  const templates = join(aiDir, 'templates')
  if (await exists(join(templates, 'AGENTS.md'))) {
    await copyFile(join(templates, 'AGENTS.md'), join(outDir, 'AGENTS.md'))
  }
  if (await exists(join(templates, 'CLAUDE.md'))) {
    await copyFile(join(templates, 'CLAUDE.md'), join(outDir, 'CLAUDE.md'))
  }

  const skills = join(aiDir, 'skills')
  if (await exists(skills)) {
    await copyTree(skills, join(outDir, '.agents', 'skills'))
  }
}

export async function scaffold(ctx: ScaffoldContext): Promise<void> {
  const files = await walk(ctx.templateDir)

  for (const src of files) {
    const rel = src.slice(ctx.templateDir.length + 1)
    const dest = join(ctx.outDir, rel)
    await mkdir(dirname(dest), { recursive: true })

    if (rel === 'package.json' || rel.endsWith('/package.json')) {
      const raw = await readFile(src, 'utf-8')
      const pkg = JSON.parse(raw) as Record<string, unknown>
      pkg.name = ctx.projectName
      await writeFile(dest, JSON.stringify(pkg, null, 2) + '\n')
    } else {
      await copyFile(src, dest)
    }
  }

  if (ctx.agentsMd === false) {
    return
  }

  const aiDir = ctx.aiDir ?? (await findAiDir(import.meta.dirname))
  if (aiDir === undefined) {
    console.error('[caffeine] skipping agent files: cannot find ai/llms.txt (pass --no-agents-md to silence this)')
    return
  }

  await copyAgentFiles(ctx.outDir, aiDir)
}
