import { skipBlockComment, skipLineComment, skipSpace, skipString } from './_scan.js'

const FROM_SRC = String.raw`(?:^|[\n;])\s*(import|export)(\s+type\b)?\s*([\s\S]{0,400}?)from\s+['"]([^'"]+)['"]`
const SIDE_SRC = String.raw`(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]`
const EXPORT_CONST_SRC = String.raw`export\s+const\s+(\w+)`

// Class decorators whose application registers a container binding, keyed by the package exporting them.
// Each one reaches `defineInjectable` in di/decorators/registrar/registrar.ts, directly or through
// `Injectable()`, which is what makes the container own the class — that is the bar for a new entry here.
// Decorators that only write to the routing, fetchy or caching registries are deliberately absent, so a
// class carrying nothing but `@APIGroup`, `@Authorize` or fetchy's `@API` is not a binding.
const REGISTERING_DECORATORS = new Map<string, Set<string>>([
  ['@caffeinejs/di', new Set(['Injectable', 'Configuration', 'Extends', 'Aspect'])],
  ['@caffeinejs/http', new Set(['Controller', 'Catch'])],
  ['@caffeinejs/kafka', new Set(['KafkaHandler'])],
  ['@caffeinejs/messaging', new Set(['MessageHandler'])],
])

const REGISTERING_NAMES = new Set([...REGISTERING_DECORATORS.values()].flatMap(names => [...names]))

/**
 * Top-level decorated classes of a module, split by what the generator can do with them.
 *
 * Only `exported` names can be referenced from a generated module. `unexported` and `foreign` exist so
 * the caller can report what it had to drop.
 */
export interface DecoratedClasses {
  exported: string[]
  unexported: string[]
  foreign: Array<{ name: string; decorator: string }>
}

/** Where a local identifier came from. `imported` is empty for a namespace binding. */
export interface ImportBinding {
  imported: string
  spec: string
  namespace: boolean
}

/**
 * Finds the top-level classes a generated module should provide.
 *
 * A class qualifies when one of its decorators both carries a name in {@link REGISTERING_DECORATORS} and
 * resolves to an import from the package that exports it. The name alone is not enough: an application's
 * own `@Controller`, or one re-exported through a local barrel, is reported in `foreign` instead, because
 * the generator cannot tell whether it registers anything. A decorator from any other package —
 * TypeORM's `@Entity`, fetchy's `@API` — is ignored silently, which is the common case.
 *
 * Both decorator placements are recognised: `@Dec export class C` and `export @Dec class C`. Decorators on
 * class members are ignored — only the class itself can be provided. A decorated `export default class`
 * counts as unexported: it has no named binding to import.
 */
export function parseDecoratedClasses(text: string): DecoratedClasses {
  const exported: string[] = []
  const unexported: string[] = []
  const foreign: Array<{ name: string; decorator: string }> = []
  const imports = parseImportBindings(text)

  let index = 0
  let braceDepth = 0
  let pending: string[] = []
  let isExport = false
  let isDefault = false

  function reset(): void {
    pending = []
    isExport = false
    isDefault = false
  }

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
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index)
      continue
    }
    if (char === '{') {
      braceDepth++
      index++
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      if (braceDepth === 0) {
        reset()
      }
      index++
      continue
    }
    if (braceDepth > 0) {
      index++
      continue
    }
    if (char === '@') {
      const decorator = skipDecorator(text, index)
      index = decorator.end
      pending.push(decorator.name)
      continue
    }
    if (char === ';') {
      reset()
      index++
      continue
    }
    if (!isIdentStart(char)) {
      index++
      continue
    }

    const wordStart = index
    while (index < text.length && isIdentPart(text[index])) {
      index++
    }
    const word = text.slice(wordStart, index)

    if (word === 'class') {
      while (index < text.length && /\s/u.test(text[index])) {
        index++
      }
      const nameStart = index
      while (index < text.length && isIdentPart(text[index])) {
        index++
      }
      const name = text.slice(nameStart, index)
      if (pending.some(decorator => isRegistering(decorator, imports))) {
        if (isExport && !isDefault && name) {
          exported.push(name)
        } else {
          unexported.push(name || 'default')
        }
      } else {
        const shadowed = pending.find(decorator => isShadowed(decorator, imports))
        if (shadowed) {
          foreign.push({ name: name || 'default', decorator: shadowed })
        }
      }
      reset()
      continue
    }

    if (word === 'export') {
      isExport = true
      continue
    }
    if (word === 'default') {
      isDefault = true
      continue
    }
    if (word === 'abstract' || word === 'declare') {
      continue
    }

    reset()
  }

  return { exported, unexported, foreign }
}

/**
 * Maps every local identifier an `import` statement binds to the export it came from.
 *
 * `{ A }`, `{ A as B }` and `* as ns` are bound; type-only imports and a default binding are not, since
 * neither can name a decorator this generator recognises. The whole source is scanned rather than matched
 * with {@link FROM_SRC}, whose clause is capped at 400 characters — a longer one would leave every
 * decorator in the file unresolved.
 */
export function parseImportBindings(text: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()

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
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index)
      continue
    }
    if (!isIdentStart(char)) {
      index++
      continue
    }

    const wordStart = index
    while (index < text.length && isIdentPart(text[index])) {
      index++
    }
    if (text.slice(wordStart, index) === 'import' && startsStatement(text, wordStart)) {
      index = readImportStatement(text, index, bindings)
    }
  }

  return bindings
}

/**
 * Import specifiers `text` treats as local sources.
 *
 * `isLocal` decides whether a specifier is worth resolving to a file — by default a relative
 * specifier (`./`, `../`). Pass a predicate that also matches tsconfig `paths` aliases to have
 * those tracked too; a bare package specifier (`@caffeinejs/di`) is still excluded either way.
 */
export function parseRelativeImports(
  text: string,
  isLocal: (spec: string) => boolean = spec => spec.startsWith('.'),
): string[] {
  const specs: string[] = []
  const seen = new Set<string>()

  const fromRe = new RegExp(FROM_SRC, 'g')
  let match: RegExpExecArray | null
  while ((match = fromRe.exec(text)) !== null) {
    if (match[2]) {
      continue
    }
    addSpec(specs, seen, match[4], isLocal)
  }

  const sideRe = new RegExp(SIDE_SRC, 'g')
  while ((match = sideRe.exec(text)) !== null) {
    addSpec(specs, seen, match[1], isLocal)
  }

  return specs
}

export function parseExportedConsts(text: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const exportRe = new RegExp(EXPORT_CONST_SRC, 'g')
  let match: RegExpExecArray | null
  while ((match = exportRe.exec(text)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

// Resolves `@Name` or `@ns.Name` to the package and export it came from, or undefined when nothing in
// this file binds its root identifier.
function resolveDecorator(
  dotted: string,
  imports: Map<string, ImportBinding>,
): { pkg: string; name: string } | undefined {
  const dot = dotted.indexOf('.')
  const root = dot === -1 ? dotted : dotted.slice(0, dot)
  const binding = imports.get(root)
  if (!binding) {
    return undefined
  }
  const name = binding.namespace ? (dot === -1 ? '' : dotted.slice(dot + 1).split('.')[0]) : binding.imported
  return { pkg: packageOf(binding.spec), name }
}

function isRegistering(dotted: string, imports: Map<string, ImportBinding>): boolean {
  const resolved = resolveDecorator(dotted, imports)
  return resolved !== undefined && (REGISTERING_DECORATORS.get(resolved.pkg)?.has(resolved.name) ?? false)
}

// True for a decorator spelled like one that registers but reaching this file by another route — a local
// declaration or a re-export. Worth a warning, because the class silently stops being provided.
function isShadowed(dotted: string, imports: Map<string, ImportBinding>): boolean {
  const name = dotted.slice(dotted.lastIndexOf('.') + 1)
  return REGISTERING_NAMES.has(name) && !isRegistering(dotted, imports)
}

// `@caffeinejs/di/internals` is still `@caffeinejs/di`; a relative specifier names no package.
function packageOf(spec: string): string {
  if (spec.startsWith('.')) {
    return ''
  }
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function startsStatement(text: string, start: number): boolean {
  for (let index = start - 1; index >= 0; index--) {
    const char = text[index]
    if (char === '\n' || char === ';' || char === '{' || char === '}') {
      return true
    }
    if (!/\s/u.test(char)) {
      return false
    }
  }
  return true
}

// Reads from just past the `import` keyword to the end of the statement, recording what it binds.
function readImportStatement(text: string, start: number, bindings: Map<string, ImportBinding>): number {
  let index = skipSpace(text, start)
  const char = text[index]
  if (char === '(') {
    return index
  }
  if (char === "'" || char === '"') {
    return skipString(text, index)
  }

  const clauseStart = index
  let clauseEnd = -1
  let depth = 0
  while (index < text.length) {
    const current = text[index]
    if (current === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index)
      continue
    }
    if (current === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index)
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      index = skipString(text, index)
      continue
    }
    if (current === '{') {
      depth++
      index++
      continue
    }
    if (current === '}') {
      depth--
      index++
      continue
    }
    if (depth === 0 && isIdentStart(current)) {
      const wordStart = index
      while (index < text.length && isIdentPart(text[index])) {
        index++
      }
      if (text.slice(wordStart, index) === 'from') {
        clauseEnd = wordStart
        break
      }
      continue
    }
    index++
  }
  if (clauseEnd === -1) {
    return index
  }

  const quote = skipSpace(text, index)
  if (text[quote] !== "'" && text[quote] !== '"') {
    return quote
  }
  const specEnd = skipString(text, quote)
  addBindings(text.slice(clauseStart, clauseEnd), text.slice(quote + 1, specEnd - 1), bindings)
  return specEnd
}

function addBindings(clause: string, spec: string, bindings: Map<string, ImportBinding>): void {
  const trimmed = clause.trim()
  if (trimmed === 'type' || /^type\s/u.test(trimmed)) {
    return
  }

  for (const match of trimmed.matchAll(/\*\s*as\s+([A-Za-z_$][\w$]*)/gu)) {
    bindings.set(match[1], { imported: '', spec, namespace: true })
  }

  const open = trimmed.indexOf('{')
  const close = trimmed.lastIndexOf('}')
  if (open === -1 || close < open) {
    return
  }
  for (const raw of trimmed.slice(open + 1, close).split(',')) {
    const part = raw.trim()
    if (!part || part === 'type' || /^type\s/u.test(part)) {
      continue
    }
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(part)
    if (match) {
      bindings.set(match[2] ?? match[1], { imported: match[1], spec, namespace: false })
    }
  }
}

// Skips `@Name.Ns(...)` including nested parens, strings and comments inside the argument list,
// so `@Controller('/cats', [Svc])` and `@Injectable(token<T>('x'))` both terminate correctly.
function skipDecorator(text: string, start: number): { end: number; name: string } {
  let index = start + 1
  while (index < text.length && (isIdentPart(text[index]) || text[index] === '.')) {
    index++
  }
  const name = text.slice(start + 1, index)
  const parenStart = skipSpace(text, index)
  if (text[parenStart] !== '(') {
    return { end: index, name }
  }

  let depth = 0
  index = parenStart
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
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index)
      continue
    }
    if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) {
        return { end: index + 1, name }
      }
    }
    index++
  }
  return { end: index, name }
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/u.test(char)
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char)
}

function addSpec(specs: string[], seen: Set<string>, spec: string, isLocal: (spec: string) => boolean): void {
  if (!isLocal(spec) || seen.has(spec)) {
    return
  }
  seen.add(spec)
  specs.push(spec)
}
