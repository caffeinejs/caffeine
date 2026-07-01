import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ScaffoldContext {
  templateDir: string
  outDir: string
  projectName: string
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(full))
    } else {
      files.push(full)
    }
  }
  return files
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
}
