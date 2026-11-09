#!/usr/bin/env node
// Packs everything a release publishes into artifacts/: a tarball of every workspace that is not `private`, and one
// package per platform that holds the caffeine binary compiled for it. The CLI's tarball names each platform package
// in its `optionalDependencies`, so an install brings the one its platform takes; package.json in the repository does
// not, because none of them exists before the first publish. artifacts/packages.json lists the tarballs in the order
// they publish: a package after every @caffeinejs package it names.
//
// Usage: npm run release:pack
//
// It cleans and builds every workspace first, so nothing a deleted source left in dist/ is packed, and it needs Bun
// to compile the binaries. It removes the binary `npm run build:cli` compiles for this machine; run that again to
// keep using the CLI from the repository.
import { execFileSync } from 'node:child_process'
import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts')
const stage = join(out, 'stage')

// Every platform the binary is built for. A package name is the one `platformPackage` in cli/binary.ts gives the
// launcher, which looks it up with `process.platform`, `process.arch` and the C library.
const PLATFORMS = [
  { os: 'linux', cpu: 'x64', libc: 'glibc', target: 'bun-linux-x64' },
  { os: 'linux', cpu: 'arm64', libc: 'glibc', target: 'bun-linux-arm64' },
  { os: 'linux', cpu: 'x64', libc: 'musl', target: 'bun-linux-x64-musl' },
  { os: 'linux', cpu: 'arm64', libc: 'musl', target: 'bun-linux-arm64-musl' },
  { os: 'darwin', cpu: 'x64', target: 'bun-darwin-x64' },
  { os: 'darwin', cpu: 'arm64', target: 'bun-darwin-arm64' },
  { os: 'win32', cpu: 'x64', target: 'bun-windows-x64' },
]

const CAFFEINE_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']

const readJSON = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJSON = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function run(command, args, cwd = root) {
  // `npm pack --json` lists every file of every package, which outgrows the default buffer as the packages grow.
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: Infinity,
  })
}

/** Runs `npm pack` on the given arguments into artifacts/, and returns each tarball's file name by package name. */
function npmPack(args, cwd = root) {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', out, ...args], cwd))
  // npm 11 prints an array, npm 12 an object keyed by package name.
  return new Map(Object.values(packed).map(({ name, filename }) => [name, filename]))
}

function platformPackage(cli, { os, cpu, libc, target }) {
  const name = `@caffeinejs/cli-${os}-${cpu}${libc === 'musl' ? '-musl' : ''}`
  const dir = join(stage, name.replace('@caffeinejs/', ''))
  const binary = join(dir, 'bin', os === 'win32' ? 'caffeine.exe' : 'caffeine')
  mkdirSync(dirname(binary), { recursive: true })
  run('bun', [join(root, 'cli', 'tools', 'compile.ts'), '--target', target, '--outfile', binary])
  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))

  const manifest = {
    name,
    version: cli.version,
    description: `The caffeine binary of ${cli.name} for ${os} ${cpu}${libc === undefined ? '' : ` ${libc}`}`,
    license: cli.license,
    author: cli.author,
    homepage: cli.homepage,
    bugs: cli.bugs,
    repository: cli.repository,
    os: [os],
    cpu: [cpu],
    ...(libc === undefined ? {} : { libc: [libc] }),
    files: ['bin'],
    publishConfig: cli.publishConfig,
  }
  writeJSON(join(dir, 'package.json'), manifest)

  return { dir, manifest }
}

/** The packages in an order where each comes after every one of them it names. */
function publishOrder(manifests) {
  const names = new Set(manifests.map(({ name }) => name))
  const order = []
  const placed = new Set()
  let left = manifests.toSorted((a, b) => a.name.localeCompare(b.name))

  while (left.length > 0) {
    const ready = left.filter(manifest =>
      CAFFEINE_DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {})).every(
        name => !names.has(name) || name === manifest.name || placed.has(name),
      ),
    )
    if (ready.length === 0) {
      throw new Error(
        `Cannot order the packages to publish: ${left.map(({ name }) => name).join(', ')} name each other in a cycle`,
      )
    }
    for (const manifest of ready) {
      order.push(manifest)
      placed.add(manifest.name)
    }
    left = left.filter(manifest => !placed.has(manifest.name))
  }

  return order
}

function main() {
  const rootManifest = readJSON(join(root, 'package.json'))
  const workspaces = globSync(
    rootManifest.workspaces.map(pattern => `${pattern}/package.json`),
    { cwd: root },
  )
    .toSorted()
    .map(file => ({ dir: join(root, dirname(file)), manifest: readJSON(join(root, file)) }))
    .filter(({ manifest }) => manifest.private !== true)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  run('npm', ['run', 'clean'])
  run('npm', ['run', 'build'])

  const cliDir = join(root, 'cli')
  const cli = readJSON(join(cliDir, 'package.json'))
  const platforms = PLATFORMS.map(platform => platformPackage(cli, platform))

  const tarballs = npmPack(workspaces.flatMap(({ dir }) => ['--workspace', dir]))
  for (const { dir } of platforms) {
    for (const [name, filename] of npmPack([dir])) {
      tarballs.set(name, filename)
    }
  }

  // The CLI is packed again from its own tarball, unpacked, with the platform packages in `optionalDependencies`.
  const staged = join(stage, 'cli')
  mkdirSync(staged)
  const cliTarball = join(out, tarballs.get(cli.name))
  run('tar', ['-xzf', cliTarball, '-C', staged, '--strip-components=1'])
  rmSync(cliTarball)
  const stagedManifest = readJSON(join(staged, 'package.json'))
  stagedManifest.optionalDependencies = Object.fromEntries(
    platforms.map(({ manifest }) => [manifest.name, manifest.version]),
  )
  writeJSON(join(staged, 'package.json'), stagedManifest)
  for (const [name, filename] of npmPack([staged])) {
    tarballs.set(name, filename)
  }

  const manifests = [
    ...workspaces.map(({ manifest }) => (manifest.name === cli.name ? stagedManifest : manifest)),
    ...platforms.map(({ manifest }) => manifest),
  ]
  const packages = publishOrder(manifests).map(({ name, version, os, cpu, libc }) => ({
    name,
    version,
    tarball: tarballs.get(name),
    ...(os === undefined ? {} : { os, cpu, libc }),
  }))
  writeJSON(join(out, 'packages.json'), packages)
  rmSync(stage, { recursive: true })

  console.log(`release:pack ok (${packages.length} packages in ${out})`)
}

main()
