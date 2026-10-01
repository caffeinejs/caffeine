#!/usr/bin/env node
// Generates each feature's `_spec/<name>.gen.json` from its `_spectypes/<name>.ts`, read from the package's build
// output: run `npm run build` first. `--check` compares instead of writing and fails on drift.
//
// The run is a pipe of stages over a list of entries, one entry per `_spectypes` file. Each stage takes the list
// and returns it, so another output is one more stage before the sink: `emit('gen.md', toMarkdown)`.
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const JSON_SCHEMA_DRAFT = 'http://json-schema.org/draft-07/schema#'

/** Runs the stages left to right; each may be sync or async. */
export const pipe =
  (...stages) =>
  input =>
    stages.reduce((acc, stage) => acc.then(stage), Promise.resolve(input))

/** Every `_spectypes/<name>.ts` in the workspaces, minus the barrel and tests. */
export function discover(root) {
  const { workspaces } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  return workspaces
    .flatMap(workspace => globSync(`${workspace}/_spectypes/*.ts`, { cwd: root }))
    .filter(file => !file.endsWith('/index.ts') && !file.endsWith('.test.ts') && !file.endsWith('.test-d.ts'))
    .toSorted()
    .map(file => {
      const pkg = dirname(dirname(file))
      const name = basename(file, '.ts')

      return {
        root,
        pkg,
        name,
        source: file,
        module: join(root, pkg, 'dist', '_spectypes', `${name}.js`),
        outputs: [],
      }
    })
}

/** Imports each entry's built module and takes its one export, which has to be a `*ConfigSchema`. */
export async function load(entries) {
  return Promise.all(
    entries.map(async entry => {
      let exports

      try {
        exports = await import(pathToFileURL(entry.module).href)
      } catch (error) {
        throw new Error(`Cannot load "${entry.source}": ${error.message}; run npm run build first`, { cause: error })
      }

      const names = Object.keys(exports)

      if (names.length !== 1 || !names[0].endsWith('ConfigSchema')) {
        throw new Error(
          `Cannot load "${entry.source}": a _spectypes file exports exactly one *ConfigSchema, found ${names.join(', ') || 'nothing'}`,
        )
      }

      return { ...entry, exportName: names[0], schema: exports[names[0]] }
    }),
  )
}

/**
 * The schema as a draft-07 document. A `$t` schema already is JSON Schema: serializing drops TypeBox's symbol keys
 * and the transforms' functions, so `$t.Duration()` is a patterned string and `$t.List()` a string-or-array union.
 */
export async function toJSONSchema(entries) {
  const { toJSONSchema: asJSONSchema } = await import('@caffeinejs/std/schema')

  return entries.map(entry => ({
    ...entry,
    json: {
      $schema: JSON_SCHEMA_DRAFT,
      title: entry.exportName,
      ...JSON.parse(JSON.stringify(asJSONSchema(entry.schema, 'input', entry.source))),
    },
  }))
}

/** Adds an output beside the entry's `_spectypes/`: `_spec/<name>.<extension>`. */
export const emit = (extension, render) => entries =>
  entries.map(entry => ({
    ...entry,
    outputs: [
      ...entry.outputs,
      { path: join(entry.root, entry.pkg, '_spec', `${entry.name}.${extension}`), content: render(entry) },
    ],
  }))

/** Renders an entry's JSON Schema the way the file is committed. */
export const asJSON = entry => `${JSON.stringify(entry.json, null, 2)}\n`

/** Writes every output. */
export function write(entries) {
  for (const { path, content } of entries.flatMap(entry => entry.outputs)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }

  return entries
}

/** Fails, naming each file, when an output differs from what is on disk or is missing. */
export function check(entries) {
  const stale = entries
    .flatMap(entry => entry.outputs.map(output => ({ ...output, root: entry.root })))
    .filter(({ path, content }) => {
      try {
        return readFileSync(path, 'utf8') !== content
      } catch {
        return true
      }
    })
    .map(({ path, root }) => relative(root, path))

  if (stale.length > 0) {
    throw new Error(`Cannot accept stale generated specs, run make spec:\n  - ${stale.join('\n  - ')}`)
  }

  return entries
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const sink = process.argv.includes('--check') ? check : write

  try {
    await pipe(discover, load, toJSONSchema, emit('gen.json', asJSON), sink)(root)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
