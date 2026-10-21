import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globby } from 'globby'
import { describe, expect, it } from 'vitest'

// The rule files send agents to other files by link, to sections by heading and to skills by name. A link to a moved
// file, a renamed heading or a deleted skill sends them nowhere, without a word: these tests make it fail instead. A
// path written as code is not a link and is not checked.

const root = fileURLToPath(new URL('..', import.meta.url))

const read = (file: string): string => readFileSync(resolve(root, file), 'utf8')

// Code spans and fenced blocks hold examples, not links.
const prose = (markdown: string): string => markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function agentDocs(): Promise<string[]> {
  return globby(
    [
      'AGENTS.md',
      'CONVENTIONS.md',
      'FEATURES.md',
      '**/AGENTS.md',
      '.agents/skills/README.md',
      '.agents/skills/*/SKILL.md',
    ],
    // `ai/` ships to applications, and its links resolve in an application's repository, not here.
    { cwd: root, dot: true, ignore: ['**/node_modules/**', '**/dist/**', 'ai/**'] },
  )
}

// The body of an AGENTS.md table: the cells of each row below the separator.
function tableOf(section: string): string[][] {
  const markdown = read('AGENTS.md')
  const start = markdown.indexOf(`\n## ${section}\n`)
  const end = markdown.indexOf('\n## ', start + 1)
  const rows = markdown
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .filter(line => line.startsWith('|'))

  return rows.slice(2).map(row =>
    row
      .split('|')
      .slice(1, -1)
      .map(cell => cell.trim()),
  )
}

function headingsOf(file: string): string[] {
  return [...read(file).matchAll(/^#{1,6} (.+)$/gm)].map(match => match[1]!.trim())
}

describe('agent docs', () => {
  it('link only to files that exist', async () => {
    const docs = await agentDocs()
    const links = docs.flatMap(doc =>
      [...prose(read(doc)).matchAll(LINK)]
        .map(match => match[1]!)
        .filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
        .map(target => ({ doc, target, path: resolve(root, dirname(doc), decodeURIComponent(target.split('#')[0]!)) })),
    )

    expect(links.filter(link => !existsSync(link.path)).map(link => `${link.doc} links ${link.target}`)).toEqual([])
    expect(links.length).toBeGreaterThan(100)
  })

  it('send each kind of file to a section that exists', () => {
    const rows = tableOf('Rule map')
    const missing = rows
      .map(([, target]) => target!)
      .filter(target => {
        const [file, heading] = target.split(' § ')
        return !existsSync(resolve(root, file!)) || (heading !== undefined && !headingsOf(file!).includes(heading))
      })

    expect(missing).toEqual([])
    expect(rows.length).toBeGreaterThan(5)
  })

  it('route work only to skills that exist, under the name the table gives', () => {
    const rows = tableOf('Skills')
    const missing = rows
      .map(([, cell]) => cell!.replace(/`/g, ''))
      .filter(name => {
        const file = resolve(root, '.agents/skills', name, 'SKILL.md')
        return !existsSync(file) || !new RegExp(`^name: ${name}$`, 'm').test(readFileSync(file, 'utf8'))
      })

    expect(missing).toEqual([])
    expect(rows.length).toBeGreaterThan(5)
  })
})
