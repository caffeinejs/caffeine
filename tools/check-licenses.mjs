#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'OFL-1.1',
])

const SKIP_WORKSPACE_PREFIXES = [
  'examples/',
  'di/examples/',
  'benchmarks',
  'cli/command/scaffold/templates/',
  'di/_tests/deno',
]

function shouldSkipWorkspace(dir) {
  const rel = relative(root, dir).replaceAll('\\', '/')
  if (rel === 'benchmarks' || rel.startsWith('benchmarks/')) {
    return true
  }
  return SKIP_WORKSPACE_PREFIXES.some(prefix => rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix))
}

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

function normalizeLicenseField(license) {
  if (license == null) {
    return undefined
  }
  if (typeof license === 'string') {
    return license
  }
  if (typeof license === 'object' && license !== null && 'type' in license && typeof license.type === 'string') {
    return license.type
  }
  return JSON.stringify(license)
}

function licenseAtoms(expression) {
  return expression
    .replaceAll('(', ' ')
    .replaceAll(')', ' ')
    .split(/\s+(?:AND|OR)\s+/i)
    .map(part => part.trim())
    .filter(Boolean)
}

function isAllowedLicense(expression) {
  const atoms = licenseAtoms(expression)
  if (atoms.length === 0) {
    return false
  }
  return atoms.every(atom => ALLOWED.has(atom))
}

/** The peers npm 7 and later install along with a package: every one it does not mark optional. */
function requiredPeers(manifest) {
  const optional = manifest.peerDependenciesMeta ?? {}
  return Object.keys(manifest.peerDependencies ?? {}).filter(name => optional[name]?.optional !== true)
}

function resolveDepLockPath(packages, fromLockPath, depName) {
  const segments = fromLockPath === '' ? [] : fromLockPath.split('/')
  for (let i = segments.length; i >= 0; i--) {
    const prefix = i === 0 ? '' : segments.slice(0, i).join('/')
    const candidate = prefix === '' ? `node_modules/${depName}` : `${prefix}/node_modules/${depName}`
    if (packages[candidate]) {
      return candidate
    }
  }
  return undefined
}

/**
 * Every package installing the workspace brings: its dependencies with all of theirs, and its required peers. A peer
 * is checked alone: it is a host such as vite or fastify that the application installs for itself, and what the host
 * brings is the application's choice.
 */
function collectProductionTree(packages, workspaceRel, manifest) {
  const found = new Map()
  const descended = new Set()
  const queue = [
    ...Object.keys(manifest.dependencies ?? {}).map(name => ({ from: workspaceRel, name, descend: true })),
    ...requiredPeers(manifest).map(name => ({ from: workspaceRel, name, descend: false })),
  ]
  const queued = new Set(queue.map(item => `${item.from}\0${item.name}`))

  while (queue.length > 0) {
    const { from, name, descend } = queue.pop()
    if (name.startsWith('@caffeinejs/')) {
      continue
    }

    const lockPath = resolveDepLockPath(packages, from, name)
    if (!lockPath) {
      found.set(name, { lockPath: '(unresolved)', license: undefined })
      continue
    }

    const entry = packages[lockPath]
    const id = entry.name ? `${entry.name}@${entry.version ?? '?'}` : `${name}@${entry.version ?? '?'}`
    found.set(id, {
      lockPath,
      license: normalizeLicenseField(entry.license),
    })
    if (!descend || descended.has(id)) {
      continue
    }
    descended.add(id)

    for (const child of Object.keys(entry.dependencies ?? {})) {
      if (child.startsWith('@caffeinejs/')) {
        continue
      }
      const key = `${lockPath}\0${child}`
      if (!queued.has(key)) {
        queued.add(key)
        queue.push({ from: lockPath, name: child, descend: true })
      }
    }
  }

  return found
}

function main() {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const packages = lock.packages ?? {}

  const workspaceDirs = []
  for (const pattern of rootPkg.workspaces ?? []) {
    workspaceDirs.push(...expandWorkspacePattern(pattern))
  }

  const violations = []
  let scanned = 0

  for (const dir of workspaceDirs) {
    if (shouldSkipWorkspace(dir)) {
      continue
    }

    const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (Object.keys(pkgJson.dependencies ?? {}).length === 0 && requiredPeers(pkgJson).length === 0) {
      continue
    }

    const workspaceRel = relative(root, dir).replaceAll('\\', '/')
    const tree = collectProductionTree(packages, workspaceRel, pkgJson)
    scanned += 1

    for (const [id, info] of tree) {
      if (id.startsWith('@caffeinejs/')) {
        continue
      }
      if (!info.license || !isAllowedLicense(info.license)) {
        violations.push({
          pkg: pkgJson.name ?? workspaceRel,
          id,
          lockPath: info.lockPath,
          license: info.license,
        })
      }
    }
  }

  if (violations.length > 0) {
    console.error(`license:check failed (${violations.length} violation(s) across ${scanned} workspace package(s)):`)
    for (const v of violations) {
      console.error(`  ${v.pkg} -> ${v.id} (${v.lockPath}): ${v.license ?? '(missing)'}`)
    }
    console.error(`\nAllowed SPDX: ${[...ALLOWED].join(', ')}`)
    process.exit(1)
  }

  console.log(`license:check ok (${scanned} workspace package(s) with dependencies or required peers)`)
}

main()
