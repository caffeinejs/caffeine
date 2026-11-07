#!/usr/bin/env node
// Fails when a package's manifest disagrees with what its code imports. Run after `npm run build`: it reads the
// emitted `.d.ts` files too.
//
// - Every package a shipped source file imports (value, type, side effect, `import()`, `require.resolve`, the JSX
//   runtime) or an emitted `.d.ts` names is declared in `dependencies` or `peerDependencies`.
// - Nothing is declared in `dependencies`, or as a required peer, that none of them names. An optional peer may be
//   named by nothing: it states which versions work of something the application passes in, such as a client a
//   structural type describes.
// - A library (no `bin`) takes every `@caffeinejs/*` package as a peer, so the application keeps one copy; a package
//   with a `bin` is an application, takes them as dependencies, and declares every required peer of its dependencies.
// - A peer is optional exactly when the `.` export does not import it statically, in its sources or its declarations.
// - Every package a test imports is declared by the package or by the root `devDependencies`.
//
// A source file is shipped when the build project (`tsconfig.build.json`) compiles it, and a test when only the check
// project (`tsconfig.json`) does. `_spectypes/` is compiled but left out of the published package, so it counts as a
// test.
import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSync } from '@swc/core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Peers a package declares for the application's own code, which the package itself never imports.
// Each is a required peer.
const LOADED_BY_THE_APPLICATION = {
  // The JSX runtime: the application's compiled `.tsx` imports it.
  '@caffeinejs/html': ['@kitajs/html'],
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

const readJSON = file => JSON.parse(readFileSync(file, 'utf8'))
const posix = path => path.replaceAll('\\', '/')
const isSpectypes = rel => rel.split('/').includes('_spectypes')

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// A scheme (`node:`, `bun:`) or a builtin is not a package.
const isBare = specifier => !/^[./#]/.test(specifier) && !/^[a-z]+:/.test(specifier) && !isBuiltin(specifier)

/** Every `.ts` and `.tsx` file of a package, without its nested packages, `dist/` or `node_modules/`. */
function sourceFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.') && !existsSync(join(path, 'package.json'))) {
        sourceFiles(path, base, out)
      }
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(posix(relative(base, path)))
    }
  }

  return out
}

// A tsconfig pattern names a file, or a directory and everything under it.
const matchesAny = (path, patterns) =>
  patterns.some(pattern => {
    const p = pattern.replace(/\/$/, '')
    return matchesGlob(path, p) || matchesGlob(path, `${p}/**`)
  })

/** Whether a tsconfig's `include` and `exclude` take a file. */
const takes = (config, rel) => matchesAny(rel, config.include ?? ['**/*']) && !matchesAny(rel, config.exclude ?? [])

function visit(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) {
      visit(child, fn)
    }
  } else if (node !== null && typeof node === 'object') {
    if (typeof node.type === 'string') {
      fn(node)
    }
    for (const key in node) {
      if (key !== 'span') {
        visit(node[key], fn)
      }
    }
  }
}

/**
 * The specifiers a file imports. `lazy` marks one loaded only when the code runs that far: `import()` or
 * `require`/`require.resolve`. An import or export declaration, a type-only one included, and a type-position
 * `import()` are not lazy.
 */
function importsOf(file) {
  let module
  try {
    module = parseSync(readFileSync(file, 'utf8'), {
      syntax: 'typescript',
      tsx: file.endsWith('.tsx'),
      decorators: true,
    })
  } catch (error) {
    throw new Error(`Cannot parse ${posix(relative(root, file))}: ${error.message ?? error}`, { cause: error })
  }

  const found = []
  visit(module.body, node => {
    if (/^(Import|ExportNamed|ExportAll)Declaration$/.test(node.type) && node.source) {
      found.push({ specifier: node.source.value, lazy: false })
    } else if (node.type === 'TsImportType') {
      found.push({ specifier: node.argument.value, lazy: false })
    } else if (node.type === 'CallExpression' && node.arguments[0]?.expression?.type === 'StringLiteral') {
      const { callee } = node
      const isRequire =
        (callee.type === 'Identifier' && callee.value === 'require') ||
        (callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.value === 'require' &&
          callee.property.value === 'resolve')
      if (callee.type === 'Import' || isRequire) {
        found.push({ specifier: node.arguments[0].expression.value, lazy: true })
      }
    }
  })

  return found
}

/** The source file a relative specifier resolves to from a directory, `.js` written for `.ts` as the sources do. */
function sourceOf(dir, specifier) {
  const target = resolve(dir, specifier)
  return [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')].find(existsSync)
}

function exportTargets(value, out = []) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      exportTargets(child, out)
    }
  }

  return out
}

/** The packages a graph of `{ relatives, packages }` nodes reaches from the given files. */
function reach(graph, starts) {
  const packages = new Set()
  const seen = new Set()
  const stack = [...starts]
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const node = graph.get(file)
    if (node) {
      node.packages.forEach(name => packages.add(name))
      stack.push(...node.relatives)
    }
  }

  return packages
}

/** The manifest of a package as installed; npm links every workspace into the root `node_modules`. */
function installedManifest(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(file)) {
      return readJSON(file)
    }
    if (dir === root) {
      return undefined
    }
  }
}

function check({ dir, manifest }, rootDevDependencies) {
  const where = `${posix(relative(root, dir))}/package.json`
  const errors = []
  const fail = message => errors.push(`Cannot accept ${where}: ${message}`)

  const dependencies = manifest.dependencies ?? {}
  const peers = manifest.peerDependencies ?? {}
  const meta = manifest.peerDependenciesMeta ?? {}
  const devDependencies = manifest.devDependencies ?? {}
  const isApplication = manifest.bin !== undefined
  const loadedByApplication = new Set(LOADED_BY_THE_APPLICATION[manifest.name])
  const declared = name => name in dependencies || name in peers

  const buildProject = readJSON(join(dir, 'tsconfig.build.json'))
  const checkProject = readJSON(join(dir, 'tsconfig.json'))
  const build = { include: buildProject.include ?? checkProject.include, exclude: buildProject.exclude }
  const jsxImportSource = buildProject.compilerOptions?.jsxImportSource ?? checkProject.compilerOptions?.jsxImportSource
  const ships = rel => takes(build, rel) && !isSpectypes(rel)

  // package -> the first file that names it
  const used = new Map()
  const tests = new Map()
  // file -> its relative imports and the packages it imports statically, for the `.` walk
  const graph = new Map()

  for (const rel of sourceFiles(dir)) {
    const shipped = ships(rel)
    if (!shipped && !takes(checkProject, rel)) {
      continue
    }

    const file = join(dir, rel)
    const imports = importsOf(file)
    if (shipped && rel.endsWith('.tsx') && jsxImportSource) {
      imports.push({ specifier: `${jsxImportSource}/jsx-runtime`, lazy: false })
    }

    const node = { relatives: [], packages: new Set() }
    for (const { specifier, lazy } of imports) {
      if (shipped && !lazy && specifier.startsWith('.')) {
        const target = sourceOf(dirname(file), specifier)
        if (target) {
          node.relatives.push(target)
        }
      }
      if (!isBare(specifier) || packageName(specifier) === manifest.name) {
        continue
      }

      const name = packageName(specifier)
      const into = shipped ? used : tests
      if (!into.has(name)) {
        into.set(name, rel)
      }
      if (shipped && !lazy) {
        node.packages.add(name)
      }
    }

    if (shipped) {
      graph.set(file, node)
    }
  }

  // What the emitted declarations name: a consumer's type-check resolves each. A declaration counts only while the
  // shipped source it was built from exists: `tsc --build` leaves the output of a deleted source behind.
  const declarations = new Map()
  if (manifest.exports) {
    const dist = join(dir, 'dist')
    if (!existsSync(dist)) {
      fail('it has no dist/ to read: run npm run build first')
      return errors
    }
    for (const rel of globSync('**/*.d.ts', { cwd: dist }).map(posix)) {
      const stem = rel.replace(/\.d\.ts$/, '')
      if (![`${stem}.ts`, `${stem}.tsx`].some(src => existsSync(join(dir, src)) && ships(src))) {
        continue
      }

      const file = join(dist, rel)
      const node = { relatives: [], packages: new Set() }
      for (const { specifier } of importsOf(file)) {
        if (specifier.startsWith('.')) {
          node.relatives.push(resolve(dirname(file), specifier).replace(/\.js$/, '.d.ts'))
          continue
        }
        if (!isBare(specifier) || packageName(specifier) === manifest.name) {
          continue
        }

        const name = packageName(specifier)
        if (!used.has(name)) {
          used.set(name, `dist/${rel}`)
        }
        node.packages.add(name)
      }
      declarations.set(file, node)
    }
  }

  for (const [name, file] of used) {
    if (!declared(name)) {
      fail(
        `"${name}" is imported by ${file} but not declared: add it to dependencies, or to peerDependencies when the application owns it`,
      )
    }
  }

  // A dependency an application declares to satisfy a required peer of another one.
  const satisfiesPeer = new Set()
  if (isApplication) {
    for (const dependency of Object.keys(dependencies)) {
      const other = installedManifest(dependency, dir)
      for (const peer of Object.keys(other?.peerDependencies ?? {})) {
        if (other.peerDependenciesMeta?.[peer]?.optional === true) {
          continue
        }
        satisfiesPeer.add(peer)
        if (!(peer in dependencies)) {
          fail(`"${peer}" is a required peer of "${dependency}" but not a dependency: add it to dependencies`)
        }
      }
    }
  }

  for (const [field, entries] of [
    ['dependencies', dependencies],
    ['peerDependencies', peers],
  ]) {
    for (const name of Object.keys(entries)) {
      const optionalPeer = entries === peers && meta[name]?.optional === true
      if (!used.has(name) && !loadedByApplication.has(name) && !satisfiesPeer.has(name) && !optionalPeer) {
        fail(
          `${field} declares "${name}" but nothing the package ships imports it: remove it, or move it to devDependencies if its tests need it`,
        )
      }
    }
  }

  const [wrongField, wrongEntries, why] = isApplication
    ? ['peerDependencies', peers, 'a package with a bin takes @caffeinejs packages as dependencies']
    : [
        'dependencies',
        dependencies,
        'a library takes @caffeinejs packages as peerDependencies, so the application keeps one copy',
      ]
  for (const name of Object.keys(wrongEntries).filter(name => name.startsWith('@caffeinejs/'))) {
    fail(`${wrongField} declares "${name}": ${why}`)
  }

  // A peer the `.` export imports statically, in its sources or its declarations, is required; any other is
  // optional. An unused one is reported above.
  if (!isApplication) {
    const exportsField = manifest.exports
    // An `exports` map keyed by condition alone (`types`, `default`) is the `.` export.
    const dot =
      typeof exportsField === 'object' && Object.keys(exportsField).some(key => key.startsWith('.'))
        ? exportsField['.']
        : exportsField
    const sources = []
    const types = []

    for (const target of exportTargets(dot)) {
      if (target.endsWith('.d.ts')) {
        types.push(join(dir, target))
      } else if (target.endsWith('.js')) {
        types.push(join(dir, target.replace(/\.js$/, '.d.ts')))
        // `dist/` mirrors the package root: `./dist/a/index.js` is built from `a/index.ts`.
        const source = sourceOf(dir, `./${target.replace(/^\.\/dist\//, '')}`)
        if (source === undefined) {
          fail(`the "." export "${target}" has no source file under ${posix(relative(root, dir))}/`)
        } else {
          sources.push(source)
        }
      }
    }

    const reached = new Set([...reach(graph, sources), ...reach(declarations, types)])

    for (const name of Object.keys(peers).filter(name => used.has(name) || loadedByApplication.has(name))) {
      const required = loadedByApplication.has(name) || reached.has(name)
      const optional = meta[name]?.optional === true
      if (required && optional) {
        fail(`peer "${name}" is marked optional but the "." export imports it: remove its peerDependenciesMeta entry`)
      } else if (!required && !optional) {
        fail(
          `peer "${name}" is required but the "." export does not import it: mark it { "optional": true } in peerDependenciesMeta`,
        )
      }
    }
  }

  for (const [name, file] of tests) {
    if (!declared(name) && !(name in devDependencies) && !(name in rootDevDependencies)) {
      fail(
        `"${name}" is imported by ${file}, a test, but declared neither by the package nor by the root devDependencies: add it to devDependencies`,
      )
    }
  }

  return errors
}

function main() {
  const rootManifest = readJSON(join(root, 'package.json'))
  const packages = globSync(
    rootManifest.workspaces.map(pattern => `${pattern}/package.json`),
    { cwd: root },
  )
    .toSorted()
    .map(file => ({ dir: join(root, dirname(file)), manifest: readJSON(join(root, file)) }))
    // A package is checked when it ships something: an `exports` map or a `bin`.
    .filter(({ manifest }) => manifest.exports || manifest.bin)

  const errors = packages.flatMap(pkg => check(pkg, rootManifest.devDependencies ?? {}))

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error)
    }
    console.error(`\npackages:check failed: ${errors.length} problem(s) across ${packages.length} package(s)`)
    process.exitCode = 1
    return
  }

  console.log(`packages:check ok (${packages.length} packages)`)
}

main()
