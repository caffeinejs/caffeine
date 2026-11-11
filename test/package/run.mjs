#!/usr/bin/env node
// Installs the tarballs `npm run release:pack` wrote into a new project outside the repository, as an application
// installs the published packages, and checks what that project gets: every export of every package loads, every
// export's declarations type-check against what the install chose, and the caffeine bin runs the binary for this
// platform. Nothing in the repository, a workspace link or a dependency hoisted to its root, can stand in for a file
// or a dependency a package forgot.
//
// Usage: node test/package/run.mjs <artifacts dir> [--pm npm|pnpm]
//
// It needs nothing but Node and the package manager, so it runs where the repository is not installed, such as an
// Alpine container. The project depends on the packages an application names; every other one, the binary's platform
// packages included, is reached the way the application reaches it, through the packages that name it.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const readJSON = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJSON = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const { values, positionals } = parseArgs({
  options: { pm: { type: 'string', default: 'npm' } },
  allowPositionals: true,
})
const artifacts = positionals[0] === undefined ? undefined : resolve(positionals[0])
if (artifacts === undefined || !['npm', 'pnpm'].includes(values.pm)) {
  console.error('Usage: node test/package/run.mjs <artifacts dir> [--pm npm|pnpm]')
  process.exit(1)
}
const pm = values.pm

/**
 * Runs a command in the project, stderr passed through, and stdout too unless `capture` is set. Windows runs npm and
 * pnpm through their `.cmd` shims, which only a shell starts; no argument here holds a space or a shell character.
 */
function spawn(cwd, command, args, capture) {
  const stdio = ['ignore', capture ? 'pipe' : 'inherit', 'inherit']
  return process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { cwd, encoding: 'utf8', stdio, shell: true })
    : spawnSync(command, args, { cwd, encoding: 'utf8', stdio })
}

/** Runs a command in the project, and returns its stdout when `capture` is set. A failure throws. */
function run(cwd, command, args, { capture = false } = {}) {
  const result = spawn(cwd, command, args, capture)
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" failed with ${result.error?.message ?? `code ${result.status}`}`)
  }

  return result.stdout
}

/** The command and arguments that run a bin the project installed. */
const bin = (name, args) =>
  pm === 'npm' ? ['npm', ['exec', '--no', '--', name, ...args]] : ['pnpm', ['exec', name, ...args]]

/** The subpaths of an `exports` map, each with whether it has JavaScript to load and declarations to check. */
function subpaths(exportsField) {
  const entries =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    Object.keys(exportsField).some(key => key.startsWith('.'))
      ? Object.entries(exportsField)
      : [['.', exportsField]]

  return entries
    .filter(([subpath]) => subpath !== './package.json')
    .map(([subpath, target]) => {
      const conditions = typeof target === 'string' ? { default: target } : (target ?? {})
      return {
        subpath,
        code: Object.keys(conditions).some(condition => condition !== 'types'),
        types: 'types' in conditions || Object.values(conditions).some(path => String(path).endsWith('.js')),
      }
    })
}

/** The source of every JavaScript file a package holds. */
function javaScriptOf(dir) {
  return readdirSync(dir, { recursive: true })
    .filter(file => file.endsWith('.js') && !file.split(/[\\/]/).includes('node_modules'))
    .map(file => readFileSync(join(dir, file), 'utf8'))
    .join('\n')
}

/** Whether code imports a package or one of its subpaths. */
function names(code, name) {
  return new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^'"]*)?['"]`).test(code)
}

function main() {
  const packages = readJSON(join(artifacts, 'packages.json'))
  const rootManifest = readJSON(join(root, 'package.json'))
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'caffeine-package-')))
  console.log(`Installing ${packages.length} packages with ${pm} into ${project}`)

  mkdirSync(join(project, 'tarballs'))
  const dependencies = {}
  const overrides = {}
  for (const { name, tarball, os } of packages) {
    copyFileSync(join(artifacts, tarball), join(project, 'tarballs', tarball))
    overrides[name] = `file:tarballs/${tarball}`
    if (os === undefined) {
      dependencies[name] = overrides[name]
    }
  }
  // A package one of them names, as a peer or an optional dependency, would come from the registry, where this
  // release is not published: the overrides point every one at its tarball. pnpm reads them from its workspace file.
  writeJSON(join(project, 'package.json'), {
    name: 'caffeine-package-test',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: {
      typescript: rootManifest.devDependencies.typescript,
      '@types/node': rootManifest.devDependencies['@types/node'],
    },
    ...(pm === 'npm' ? { overrides } : {}),
  })
  if (pm === 'pnpm') {
    writeJSON(join(project, 'pnpm-workspace.yaml'), { overrides })
  }
  // CI makes pnpm install from the lockfile only, but the second install below adds specifiers the first one did not
  // write: the project's lockfile is this test's own, so it is not frozen.
  const install =
    pm === 'npm'
      ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-frozen-lockfile']
  run(project, pm, install)

  // An export may import an optional peer, which an install leaves out: the application adds it when it uses that
  // export. Each one the package's JavaScript names goes in, as the application's own dependency.
  const manifests = Object.keys(dependencies).map(name => readJSON(join(project, 'node_modules', name, 'package.json')))
  const optionalPeers = {}
  for (const manifest of manifests) {
    const code = javaScriptOf(join(project, 'node_modules', manifest.name))
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true
      if (optional && !(name in dependencies) && !(name in optionalPeers) && names(code, name)) {
        optionalPeers[name] = range
      }
    }
  }
  if (Object.keys(optionalPeers).length > 0) {
    const manifest = readJSON(join(project, 'package.json'))
    writeJSON(join(project, 'package.json'), { ...manifest, dependencies: { ...dependencies, ...optionalPeers } })
    run(project, pm, install)
  }

  const failures = []
  const check = (what, fn) => {
    try {
      fn()
      console.log(`ok: ${what}`)
    } catch (error) {
      failures.push(`${what}: ${error.message}`)
    }
  }

  const exported = manifests.flatMap(manifest =>
    subpaths(manifest.exports).map(entry => ({ ...entry, specifier: manifest.name + entry.subpath.slice(1) })),
  )

  check('every export loads', () => {
    const specifiers = exported.filter(({ code }) => code).map(({ specifier }) => specifier)
    writeFileSync(
      join(project, 'imports.mjs'),
      `let failed = 0
for (const specifier of ${JSON.stringify(specifiers)}) {
  try {
    await import(specifier)
  } catch (error) {
    failed++
    console.error(\`Cannot import "\${specifier}": \${error.message}\`)
  }
}
process.exit(failed === 0 ? 0 : 1)
`,
    )
    run(project, 'node', ['imports.mjs'])
  })

  check('every export type-checks', () => {
    const specifiers = exported.filter(({ types }) => types).map(({ specifier }) => specifier)
    writeFileSync(
      join(project, 'types.ts'),
      specifiers.map((specifier, i) => `import type * as m${i} from '${specifier}'\n`).join(''),
    )
    // The compiler options of the project `caffeine scaffold` writes, checking every declaration file.
    writeJSON(join(project, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['esnext', 'Decorators', 'esnext.decorators'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      files: ['types.ts'],
    })
    // An error in another library's declarations is that library's to fix, and an application skips it with
    // `skipLibCheck`: it is shown, and fails nothing. tsc that ends in failure with nothing but those passes; any other
    // failure fails, an error without a file and a tsc that never started included.
    const result = spawn(project, ...bin('tsc', ['-p', '.']), true)
    const lines = (result.stdout ?? '').split('\n').map(line => line.trimEnd())
    // A path is relative to the project, and Windows writes it with backslashes or, from another drive, as `../`
    // segments: the package is a `node_modules` segment anywhere in it. pnpm lays a package out under
    // node_modules/.pnpm/<id>/node_modules/<name>/.
    const theirs = lines.filter(
      line =>
        /\): error TS\d+:/.test(line) &&
        /(^|[\\/])node_modules[\\/]/.test(line) &&
        !/(^|[\\/])node_modules[\\/]@caffeinejs[\\/]/.test(line),
    )
    for (const line of theirs) {
      console.log(`note: ${line}`)
    }
    if (
      result.status !== 0 &&
      (theirs.length === 0 || lines.some(line => /error TS\d+:/.test(line) && !theirs.includes(line)))
    ) {
      const ours = lines.filter(line => line !== '' && !theirs.includes(line))
      throw new Error(`tsc failed with ${result.error?.message ?? `code ${result.status}`}:\n${ours.join('\n')}`)
    }
  })

  const cli = packages.find(({ name }) => name === '@caffeinejs/cli')
  check('caffeine --version prints the version installed', () => {
    const printed = run(project, ...bin('caffeine', ['--version']), { capture: true }).trim()
    if (printed !== cli.version) {
      throw new Error(`it printed "${printed}", not "${cli.version}"`)
    }
  })

  check('caffeine scaffold writes a project', () => {
    run(project, ...bin('caffeine', ['scaffold', 'demo', '--arch', 'usecase']))
    const { name } = readJSON(join(project, 'demo', 'package.json'))
    if (name !== 'demo') {
      throw new Error(`demo/package.json is named "${name}", not "demo"`)
    }
  })

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Cannot accept the packages: ${failure}`)
    }
    console.error(`\nThe project is kept in ${project}`)
    process.exitCode = 1
    return
  }

  rmSync(project, { recursive: true, force: true })
  console.log(`package test ok (${packages.length} packages, ${exported.length} exports, ${pm})`)
}

main()
