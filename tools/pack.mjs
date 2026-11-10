#!/usr/bin/env node
// Packs everything a release publishes into artifacts/: a tarball of every workspace that is not `private`, and one
// package per platform that holds the caffeine binary compiled for it. The CLI's tarball names each platform package
// in its `optionalDependencies`, so an install brings the one its platform takes; package.json in the repository does
// not, because none of them exists before the first publish. artifacts/packages.json lists the tarballs in the order
// they publish: a package after every @caffeinejs package it names.
//
// Each platform package holds sbom.cdx.json, a CycloneDX SBOM of its binary: the Bun runtime and every package the
// bundle holds a file of. artifacts/ holds a copy of each, named after its tarball.
//
// Usage: npm run release:pack
//        npm run release:pin-bun
//
// It cleans and builds every workspace first, so nothing a deleted source left in dist/ is packed. It removes the
// binary `npm run build:cli` compiles for this machine; run that again to keep using the CLI from the repository.
//
// The binaries are compiled by, and from, the Bun runtimes tools/bun-runtimes.json pins for the version root
// package.json `engines.bun` names, fetched from npm: a runtime whose tarball is not the pinned one stops it before
// anything is built, and it needs no Bun installed. `release:pin-bun` pins the runtimes of `engines.bun` from npm;
// run it after changing `engines.bun`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts')
const stage = join(out, 'stage')
const pins = join(root, 'tools', 'bun-runtimes.json')

// Every platform the binary is built for. A package name is the one `platformPackage` in cli/binary.ts gives the
// launcher, which looks it up with `process.platform`, `process.arch` and the C library. `runtime` is the npm package
// Bun takes the target's runtime from, which spells arm64 `aarch64`.
const PLATFORMS = [
  { os: 'linux', cpu: 'x64', libc: 'glibc', target: 'bun-linux-x64', runtime: '@oven/bun-linux-x64' },
  { os: 'linux', cpu: 'arm64', libc: 'glibc', target: 'bun-linux-arm64', runtime: '@oven/bun-linux-aarch64' },
  { os: 'linux', cpu: 'x64', libc: 'musl', target: 'bun-linux-x64-musl', runtime: '@oven/bun-linux-x64-musl' },
  { os: 'linux', cpu: 'arm64', libc: 'musl', target: 'bun-linux-arm64-musl', runtime: '@oven/bun-linux-aarch64-musl' },
  { os: 'darwin', cpu: 'x64', target: 'bun-darwin-x64', runtime: '@oven/bun-darwin-x64' },
  { os: 'darwin', cpu: 'arm64', target: 'bun-darwin-arm64', runtime: '@oven/bun-darwin-aarch64' },
  { os: 'win32', cpu: 'x64', target: 'bun-windows-x64', runtime: '@oven/bun-windows-x64' },
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

/** Runs `npm pack` on the given arguments into a directory, and returns each tarball's file name by package name. */
function npmPack(args, destination = out) {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', destination, ...args]))
  // npm 11 prints an array, npm 12 an object keyed by package name.
  return new Map(Object.values(packed).map(({ name, filename }) => [name, filename]))
}

/** The integrity npm gives a tarball: its SHA-512, in base64. */
function integrityOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

/** Pins the integrity npm gives each platform's Bun runtime at a version into tools/bun-runtimes.json. */
function pinBun(version) {
  const integrity = Object.fromEntries(
    PLATFORMS.map(({ runtime }) => {
      const value = run('npm', ['view', `${runtime}@${version}`, 'dist.integrity']).trim()
      if (!value.startsWith('sha512-')) {
        throw new Error(`Cannot pin ${runtime}@${version}: npm gives it no SHA-512 integrity: "${value}"`)
      }
      return [runtime, value]
    }),
  )
  writeJSON(pins, { version, integrity })
  console.log(`release:pin-bun ok (Bun ${version}, ${PLATFORMS.length} runtimes in ${pins})`)
}

/**
 * Fetches each platform's Bun runtime at a version from npm into a directory, refusing a tarball that is not the one
 * tools/bun-runtimes.json pins, and returns each runtime by its package name: its executable, integrity and license.
 */
function fetchRuntimes(version, dir) {
  const pinned = readJSON(pins)
  if (pinned.version !== version) {
    throw new Error(
      `Cannot pack: tools/bun-runtimes.json pins Bun ${pinned.version}, but package.json engines.bun is ${version}: run npm run release:pin-bun`,
    )
  }

  mkdirSync(dir)
  const runtimes = new Map()
  for (const { os, runtime } of PLATFORMS) {
    if (pinned.integrity[runtime] === undefined) {
      throw new Error(`Cannot pack: tools/bun-runtimes.json pins no ${runtime}: run npm run release:pin-bun`)
    }
    const [[, filename]] = npmPack([`${runtime}@${version}`], dir)
    const tarball = join(dir, filename)
    const integrity = integrityOf(tarball)
    if (integrity !== pinned.integrity[runtime]) {
      throw new Error(
        `Cannot pack: npm served ${runtime}@${version} as ${integrity}, not as the ${pinned.integrity[runtime]} tools/bun-runtimes.json pins: find out why before pinning it again`,
      )
    }
    const unpacked = join(dir, runtime.replace('@oven/', ''))
    mkdirSync(unpacked)
    run('tar', ['-xzf', tarball, '-C', unpacked, '--strip-components=1'])
    rmSync(tarball)
    runtimes.set(runtime, {
      name: runtime,
      version,
      integrity,
      license: readJSON(join(unpacked, 'package.json')).license,
      executable: join(unpacked, 'bin', os === 'win32' ? 'bun.exe' : 'bun'),
    })
  }

  return runtimes
}

/** The entry of PLATFORMS this machine is, whose runtime compiles every binary. */
function hostPlatform() {
  // Only glibc reports its runtime version, as `isMusl` in cli/binary.ts reads it.
  const libc =
    process.platform === 'linux'
      ? process.report.getReport().header.glibcVersionRuntime === undefined
        ? 'musl'
        : 'glibc'
      : undefined
  const host = PLATFORMS.find(({ os, cpu, libc: l }) => os === process.platform && cpu === process.arch && l === libc)
  if (host === undefined) {
    throw new Error(
      `Cannot pack on ${process.platform} ${process.arch}${libc === undefined ? '' : ` ${libc}`}: no Bun runtime is pinned for it: pack on a platform tools/pack.mjs lists`,
    )
  }

  return host
}

/** The package URL of an npm package. */
const purl = (name, version) => `pkg:npm/${name.replace('@', '%40')}@${version}`

/** A CycloneDX component of an npm package, with the SHA-512 of its tarball when npm gives one. */
function component(type, { name, version, license, integrity }) {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  return {
    type,
    'bom-ref': purl(name, version),
    ...(slash === -1 ? { name } : { group: name.slice(0, slash), name: name.slice(slash + 1) }),
    version,
    purl: purl(name, version),
    ...(license === undefined ? {} : { licenses: [{ expression: license }] }),
    ...(integrity === undefined
      ? {}
      : {
          hashes: [
            { alg: 'SHA-512', content: Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex') },
          ],
        }),
  }
}

/**
 * The packages of package-lock.json the bundle Bun's metafile describes holds a file of, each with the name, version,
 * license and integrity the lock gives it.
 */
function bundledPackages(metafile, lock) {
  // npm may install one version of a package in several places: each is listed once.
  const packages = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    // Bun writes each input relative to where it ran, the repository root.
    let dir = dirname(relative(root, resolve(root, input)))
      .split(sep)
      .join('/')
    while (dir !== '.' && !(dir in lock)) {
      dir = dirname(dir)
    }
    if (dir === '.') {
      throw new Error(`Cannot write the SBOM: the binary bundles ${input}, which no package in package-lock.json holds`)
    }
    const {
      name = dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version,
      license,
      integrity,
    } = lock[dir]
    packages.set(`${name}@${version}`, { name, version, license, integrity })
  }

  return [...packages.values()]
}

/** A CycloneDX SBOM of a platform package: the Bun runtime its binary runs on and every package the binary bundles. */
function sbom(manifest, runtime, bundled) {
  const binary = component('application', manifest)
  const components = [
    component('platform', runtime),
    ...bundled.map(pkg => component('library', pkg)).toSorted((a, b) => a.purl.localeCompare(b.purl)),
  ]
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: binary },
    components,
    dependencies: [{ ref: binary['bom-ref'], dependsOn: components.map(({ 'bom-ref': ref }) => ref) }],
  }
}

function platformPackage(cli, { os, cpu, libc, target, runtime }, { runtimes, host, lock }) {
  const name = `@caffeinejs/cli-${os}-${cpu}${libc === 'musl' ? '-musl' : ''}`
  const dir = join(stage, name.replace('@caffeinejs/', ''))
  const binary = join(dir, 'bin', os === 'win32' ? 'caffeine.exe' : 'caffeine')
  const metafile = join(stage, `${name.replace('@caffeinejs/', '')}.meta.json`)
  mkdirSync(dirname(binary), { recursive: true })
  run(runtimes.get(host.runtime).executable, [
    join(root, 'cli', 'tools', 'compile.ts'),
    '--target',
    target,
    '--outfile',
    binary,
    '--executable-path',
    runtimes.get(runtime).executable,
    '--metafile',
    metafile,
  ])
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
    files: ['bin', 'sbom.cdx.json'],
    publishConfig: cli.publishConfig,
  }
  writeJSON(join(dir, 'package.json'), manifest)
  writeJSON(
    join(dir, 'sbom.cdx.json'),
    sbom(manifest, runtimes.get(runtime), bundledPackages(readJSON(metafile), lock)),
  )

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
  const { values } = parseArgs({ options: { 'pin-bun': { type: 'boolean', default: false } } })
  const rootManifest = readJSON(join(root, 'package.json'))
  if (values['pin-bun']) {
    pinBun(rootManifest.engines.bun)
    return
  }

  const workspaces = globSync(
    rootManifest.workspaces.map(pattern => `${pattern}/package.json`),
    { cwd: root },
  )
    .toSorted()
    .map(file => ({ dir: join(root, dirname(file)), manifest: readJSON(join(root, file)) }))
    .filter(({ manifest }) => manifest.private !== true)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const host = hostPlatform()
  const runtimes = fetchRuntimes(rootManifest.engines.bun, join(stage, 'runtimes'))
  run('npm', ['run', 'clean'])
  run('npm', ['run', 'build'])

  const cliDir = join(root, 'cli')
  const cli = readJSON(join(cliDir, 'package.json'))
  const lock = readJSON(join(root, 'package-lock.json')).packages
  const platforms = PLATFORMS.map(platform => platformPackage(cli, platform, { runtimes, host, lock }))

  const tarballs = npmPack(workspaces.flatMap(({ dir }) => ['--workspace', dir]))
  for (const { dir } of platforms) {
    for (const [name, filename] of npmPack([dir])) {
      tarballs.set(name, filename)
      copyFileSync(join(dir, 'sbom.cdx.json'), join(out, filename.replace(/\.tgz$/, '.cdx.json')))
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
