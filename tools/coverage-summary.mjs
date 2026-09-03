#!/usr/bin/env node

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const summaryPath = join(root, 'coverage', 'coverage-summary.json')

function expandWorkspacePattern(pattern) {
  if (!pattern.includes('*')) {
    const dir = resolve(root, pattern)
    return existsSync(join(dir, 'package.json')) ? [dir] : []
  }

  const star = pattern.indexOf('*')
  const base = pattern.slice(0, star).replace(/\/$/, '')
  const baseDir = resolve(root, base)
  if (!existsSync(baseDir)) {
    return []
  }

  return readdirSync(baseDir, { withFileTypes: true })
    .filter(ent => ent.isDirectory())
    .map(ent => join(baseDir, ent.name))
    .filter(dir => existsSync(join(dir, 'package.json')))
}

function workspacePrefixes() {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const dirs = []
  for (const pattern of rootPkg.workspaces ?? []) {
    dirs.push(...expandWorkspacePattern(pattern))
  }
  return dirs
    .map(dir => relative(root, dir).replaceAll('\\', '/'))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

function packageForFile(relFile, prefixes) {
  const normalized = relFile.replaceAll('\\', '/')
  return prefixes.find(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

function fmtPct(covered, total) {
  if (total === 0) {
    return 'n/a'
  }
  return `${((covered / total) * 100).toFixed(1)}%`
}

function emit(markdown) {
  process.stdout.write(markdown)
  const out = process.env.GITHUB_STEP_SUMMARY
  if (out) {
    appendFileSync(out, markdown)
  }
}

function main() {
  if (!existsSync(summaryPath)) {
    emit('Coverage summary not found; skipping table.\n')
    return
  }

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  const prefixes = workspacePrefixes()
  const byPkg = new Map()

  for (const [key, stats] of Object.entries(summary)) {
    if (key === 'total' || !stats?.lines) {
      continue
    }
    const rel = relative(root, key)
    if (rel.startsWith(`..${sep}`) || rel === '..') {
      continue
    }
    const pkg = packageForFile(rel, prefixes)
    if (!pkg) {
      continue
    }
    const entry = byPkg.get(pkg) ?? { covered: 0, total: 0 }
    entry.covered += stats.lines.covered ?? 0
    entry.total += stats.lines.total ?? 0
    byPkg.set(pkg, entry)
  }

  const rows = [...byPkg.entries()].sort(([a], [b]) => a.localeCompare(b))
  const total = summary.total?.lines
  const lines = [
    '### Coverage',
    '',
    '| Package | Lines |',
    '| --- | ---: |',
    ...rows.map(([pkg, n]) => `| ${pkg} | ${fmtPct(n.covered, n.total)} |`),
  ]
  if (total) {
    lines.push(`| **total** | ${fmtPct(total.covered ?? 0, total.total ?? 0)} |`)
  }
  lines.push('')
  emit(`${lines.join('\n')}\n`)
}

main()
