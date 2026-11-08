#!/usr/bin/env node
// Sets one version on the root and on every workspace that has one, and pins every @caffeinejs/* specifier to it:
// in each workspace's dependency fields and in the CLI's scaffold templates, whose own version is the scaffolded
// application's and stays. Then syncs package-lock.json.
//
// Usage: npm run release:version -- <version>
//
// The version is written as given, never computed. It may equal the current one, which re-pins the specifiers; it
// may not be lower.
import { execFileSync } from 'node:child_process'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']
const SCAFFOLD_TEMPLATES = 'cli/command/scaffold/templates/**/package.json'

// SemVer 2.0.0 without build metadata, which npm drops when it publishes.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

/** SemVer precedence: negative when `a` comes before `b`. */
function compare(a, b) {
  const [, ...pa] = SEMVER.exec(a)
  const [, ...pb] = SEMVER.exec(b)
  for (let i = 0; i < 3; i++) {
    if (Number(pa[i]) !== Number(pb[i])) {
      return Number(pa[i]) - Number(pb[i])
    }
  }
  // A version without a prerelease comes after every prerelease of it.
  if (pa[3] === undefined || pb[3] === undefined) {
    return (pa[3] === undefined) - (pb[3] === undefined)
  }

  const ia = pa[3].split('.')
  const ib = pb[3].split('.')
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const na = /^\d+$/.test(ia[i])
    const nb = /^\d+$/.test(ib[i])
    if (na && nb && Number(ia[i]) !== Number(ib[i])) {
      return Number(ia[i]) - Number(ib[i])
    }
    if (na !== nb) {
      return na ? -1 : 1
    }
    if (!na && ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1
    }
  }

  return ia.length - ib.length
}

function main() {
  const version = process.argv[2]
  if (version === undefined || !SEMVER.test(version)) {
    console.error(`Cannot set the version "${version ?? ''}": it is not a SemVer version such as 0.0.1-rc.1`)
    console.error('Usage: npm run release:version -- <version>')
    process.exitCode = 1
    return
  }

  const rootFile = join(root, 'package.json')
  const rootManifest = JSON.parse(readFileSync(rootFile, 'utf8'))
  if (!SEMVER.test(rootManifest.version ?? '')) {
    console.error(
      `Cannot set the version "${version}": the root package.json version "${rootManifest.version ?? ''}" is not SemVer: fix it by hand first`,
    )
    process.exitCode = 1
    return
  }
  if (compare(version, rootManifest.version) < 0) {
    console.error(`Cannot set the version "${version}": it is lower than the current "${rootManifest.version}"`)
    process.exitCode = 1
    return
  }

  const versioned = [
    'package.json',
    ...globSync(
      rootManifest.workspaces.map(pattern => `${pattern}/package.json`),
      { cwd: root },
    ),
  ]
  const files = [...versioned, ...globSync(SCAFFOLD_TEMPLATES, { cwd: root })]

  let changed = 0
  for (const file of files) {
    const path = join(root, file)
    const before = readFileSync(path, 'utf8')
    const manifest = JSON.parse(before)

    if (versioned.includes(file) && (file === 'package.json' || manifest.version !== undefined)) {
      manifest.version = version
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith('@caffeinejs/')) {
          manifest[field][name] = version
        }
      }
    }

    const after = `${JSON.stringify(manifest, null, 2)}\n`
    if (after !== before) {
      writeFileSync(path, after)
      changed++
    }
  }

  try {
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: root, stdio: 'inherit' })
  } catch {
    console.error(
      `Cannot sync package-lock.json: ${changed} manifests already carry ${version}: fix what npm reported, then run npm install --package-lock-only --ignore-scripts`,
    )
    process.exitCode = 1
    return
  }
  console.log(`release:version set ${version} in ${changed} of ${files.length} manifests and synced package-lock.json`)
}

main()
