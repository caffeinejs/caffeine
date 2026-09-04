import { dirname, join, resolve } from 'node:path'

import { normalizeResolvedPath } from './_module_graph_emit.js'
import { skipBlockComment, skipLineComment, skipSpace, skipString } from './_scan.js'

export interface AliasResolver {
  /** Absolute, extension-normalized target for `spec`, or undefined if no `paths` entry matches. */
  resolve(spec: string): string | undefined
}

interface PathsEntry {
  prefix: string
  suffix: string
  wildcard: boolean
  target: string
}

interface TsconfigOptions {
  baseUrl?: string
  paths?: Record<string, string[]>
}

const MAX_EXTENDS_DEPTH = 20

/**
 * Builds a resolver for a project's tsconfig `paths` aliases, so the module graph generator can
 * follow an aliased import to the file it names.
 *
 * Returns undefined when `tsconfigPath` does not exist — alias resolution is opt-in by the file's
 * presence, not a required part of every project.
 *
 * @throws Error when an existing tsconfig cannot be parsed, or its `extends` chain cycles
 */
export async function buildAliasResolver(tsconfigPath: string): Promise<AliasResolver | undefined> {
  if (!(await Bun.file(tsconfigPath).exists())) {
    return undefined
  }

  const { baseUrl, paths } = await resolveEffectiveOptions(tsconfigPath)
  if (!paths) {
    return undefined
  }

  const baseAbs = baseUrl ?? dirname(tsconfigPath)
  const entries = Object.entries(paths)
    .map(([key, targets]): PathsEntry | undefined => {
      const target = targets[0]
      if (target === undefined) {
        return undefined
      }
      const star = key.indexOf('*')
      return star === -1
        ? { prefix: key, suffix: '', wildcard: false, target }
        : { prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, target }
    })
    .filter((entry): entry is PathsEntry => entry !== undefined)
    // Longest prefix wins when several wildcard keys match; an exact key always outranks a wildcard.
    .sort((a, b) => b.prefix.length - a.prefix.length)

  return {
    resolve(spec: string): string | undefined {
      for (const entry of entries) {
        if (!entry.wildcard) {
          if (spec === entry.prefix) {
            return normalizeResolvedPath(resolve(baseAbs, entry.target))
          }
          continue
        }
        if (
          spec.startsWith(entry.prefix) &&
          spec.endsWith(entry.suffix) &&
          spec.length >= entry.prefix.length + entry.suffix.length
        ) {
          const captured = spec.slice(entry.prefix.length, spec.length - entry.suffix.length)
          return normalizeResolvedPath(resolve(baseAbs, entry.target.replace('*', captured)))
        }
      }
      return undefined
    },
  }
}

// Walks `extends` from `tsconfigPath` upward, taking baseUrl/paths from the first file in the
// chain that defines them at all — matching tsc: a file that sets `paths` fully replaces its
// parent's, one that omits it inherits the parent's untouched.
async function resolveEffectiveOptions(tsconfigPath: string): Promise<TsconfigOptions> {
  const visited = new Set<string>()
  let current: string | undefined = tsconfigPath

  for (let depth = 0; current && depth < MAX_EXTENDS_DEPTH; depth++) {
    if (visited.has(current)) {
      throw new Error(`Cannot resolve tsconfig "${tsconfigPath}": extends cycle detected at "${current}"`)
    }
    visited.add(current)

    const config = await readTsconfig(current)
    const options = config.compilerOptions ?? {}
    if (options.baseUrl !== undefined || options.paths !== undefined) {
      return {
        baseUrl: options.baseUrl !== undefined ? resolve(dirname(current), options.baseUrl) : undefined,
        paths: options.paths,
      }
    }

    current = nextExtends(current, config.extends)
  }

  return {}
}

// A non-relative extends target (a package specifier, e.g. "@tsconfig/node20") is not resolved —
// documented as a limitation rather than an error, since resolving it means node_modules package
// resolution this file otherwise has no reason to implement.
function nextExtends(fromPath: string, target: unknown): string | undefined {
  if (typeof target !== 'string' || !(target.startsWith('./') || target.startsWith('../'))) {
    return undefined
  }
  const withExt = target.endsWith('.json') ? target : target + '.json'
  return join(dirname(fromPath), withExt)
}

interface RawTsconfig {
  extends?: unknown
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
}

async function readTsconfig(path: string): Promise<RawTsconfig> {
  const text = await Bun.file(path).text()
  try {
    return JSON.parse(stripJSONC(text)) as RawTsconfig
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Cannot parse tsconfig "${path}": ${reason}`)
  }
}

// tsconfig.json is JSONC: `//` and `/* */` comments, and a trailing comma before `}`/`]`, are both
// allowed. Strip them (protecting string contents via the same scanner the decorator parser uses)
// so the result is parseable by JSON.parse.
function stripJSONC(text: string): string {
  let out = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index)
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index)
      continue
    }
    if (char === '"') {
      const end = skipString(text, index)
      out += text.slice(index, end)
      index = end
      continue
    }
    if (char === ',') {
      const after = skipSpace(text, index + 1)
      if (text[after] === '}' || text[after] === ']') {
        index++
        continue
      }
    }

    out += char
    index++
  }

  return out
}
