#!/usr/bin/env node
// Publishes the tarballs `npm run release:pack` wrote, in the order artifacts/packages.json lists them. A version npm
// already has is skipped, so running it again after a failure publishes only what is left.
//
// Usage: node tools/publish.mjs [<artifacts dir>] [--dry-run]
//
// The dist-tag follows the version: below 1.0.0 every version goes under `latest`, so an install without a version
// takes the newest release candidate; from 1.0.0 on, a prerelease goes under `next` and a release under `latest`.
// `--dry-run` asks npm to rehearse each publish, and needs no login.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

/** The dist-tag a version is published under. */
function distTag(version) {
  const [, major, , , prerelease] = VERSION.exec(version)
  return major !== '0' && prerelease !== undefined ? 'next' : 'latest'
}

/** Whether npm has this version of the package; a package npm has never seen has none. */
function isPublished(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' })
  if (result.status === 0) {
    return true
  }

  let code
  try {
    code = JSON.parse(result.stdout).error?.code
  } catch {
    // Not the JSON error npm prints for a version it does not have: reported below.
  }
  if (code === 'E404') {
    return false
  }

  throw new Error(
    `Cannot tell whether ${name}@${version} is published: npm view failed with ${result.error?.message ?? (result.stderr.trim() || `code ${result.status}`)}`,
  )
}

function main() {
  const { values, positionals } = parseArgs({
    options: { 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
  })
  const dir = resolve(positionals[0] ?? 'artifacts')
  const dryRun = values['dry-run']
  const packages = JSON.parse(readFileSync(join(dir, 'packages.json'), 'utf8'))

  // Checked before the first publish, so a broken set publishes nothing.
  const versions = new Set(packages.map(({ version }) => version))
  if (versions.size !== 1) {
    throw new Error(`Cannot publish ${dir}: it holds more than one version (${[...versions].join(', ')}): pack again`)
  }
  const [version] = versions
  if (!VERSION.test(version)) {
    throw new Error(`Cannot publish ${dir}: "${version}" is not a SemVer version such as 0.0.1-rc.1`)
  }
  for (const { tarball } of packages) {
    if (!existsSync(join(dir, tarball))) {
      throw new Error(`Cannot publish ${dir}: packages.json lists ${tarball}, which is not there: pack again`)
    }
  }

  const tag = distTag(version)
  let skipped = 0
  for (const { name, tarball } of packages) {
    if (isPublished(name, version)) {
      console.log(`${name}@${version} is published already: skipped`)
      skipped++
      continue
    }
    execFileSync(
      'npm',
      ['publish', join(dir, tarball), '--tag', tag, '--access', 'public', ...(dryRun ? ['--dry-run'] : [])],
      { stdio: 'inherit' },
    )
  }

  console.log(
    `publish ok: ${packages.length - skipped} package(s) ${dryRun ? 'rehearsed' : 'published'} at ${version} under "${tag}", ${skipped} published already`,
  )
}

main()
