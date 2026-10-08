#!/usr/bin/env node
// Copies the error message builder into the packages that cannot depend on `@caffeinejs/std`.
// `copy-err-message.json`, next to this file, names the source and, for each package, where its copy goes. A copy is
// the source under a generated header, written only when it changed. `make check` runs this, so no copy goes stale.
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const STD = '@caffeinejs/std'
const GENERATED = '.gen.ts'

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Every workspace package's npm name, mapped to its directory relative to the root. */
function workspacePackages(root) {
  const { workspaces } = readJSON(join(root, 'package.json'))
  const packages = new Map()

  for (const dir of workspaces.flatMap(pattern => globSync(pattern, { cwd: root }))) {
    const manifest = join(root, dir, 'package.json')

    if (existsSync(manifest)) {
      packages.set(readJSON(manifest).name, dir)
    }
  }

  return packages
}

/** Resolves each configured copy to a file, refusing any the builder must not be copied to. */
function targets(root, copies) {
  const packages = workspacePackages(root)

  return Object.entries(copies).map(([name, path]) => {
    const refuse = reason => new Error(`Cannot copy the error message builder to "${name}": ${reason}`)
    const dir = packages.get(name)

    if (dir === undefined) {
      throw refuse('no workspace package has that name')
    }

    if (isAbsolute(path)) {
      throw refuse(`"${path}" is absolute, and a copy is placed by its path inside the package`)
    }

    const file = resolve(root, dir, path)
    const inside = relative(resolve(root, dir), file)

    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw refuse(`"${path}" is outside the package`)
    }

    if (!path.endsWith(GENERATED)) {
      throw refuse(`"${path}" does not end in "${GENERATED}", which marks a generated file`)
    }

    const { dependencies = {}, peerDependencies = {} } = readJSON(join(root, dir, 'package.json'))

    if (STD in dependencies || STD in peerDependencies) {
      throw refuse(`it depends on "${STD}", so it imports the builder from "${STD}/framework/err" instead`)
    }

    return file
  })
}

/** Writes every copy whose content changed, and returns the files it wrote. */
function copy(root) {
  const { source, copies } = readJSON(join(root, 'tools', 'copy-err-message.json'))
  const header =
    `// Generated from ${source} by tools/copy-err-message.mjs. Do not edit: change the source and\n` +
    '// run `make err-message`, which `make check` also runs.\n\n'
  const content = header + readFileSync(join(root, source), 'utf8')
  const written = []

  for (const file of targets(root, copies)) {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) {
      continue
    }

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    written.push(relative(root, file))
  }

  return written
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  try {
    for (const file of copy(root)) {
      console.log(`Wrote ${file}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
