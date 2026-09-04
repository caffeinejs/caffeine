const FROM_SRC = String.raw`(?:^|[\n;])\s*(import|export)(\s+type\b)?\s*([\s\S]{0,400}?)from\s+['"]([^'"]+)['"]`
const SIDE_SRC = String.raw`(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]`
const EXPORT_CONST_SRC = String.raw`export\s+const\s+(\w+)`

/**
 * Top-level decorated classes of a module, split by whether they carry a named export.
 *
 * Only `exported` names can be referenced from a generated module. `unexported` exists so the
 * caller can report what it had to drop.
 */
export interface DecoratedClasses {
  exported: string[]
  unexported: string[]
}

/**
 * Finds the top-level decorated classes in a TypeScript source.
 *
 * Both decorator placements are recognised: `@Dec export class C` and `export @Dec class C`.
 * Decorators on class members are ignored — only the class itself can be provided. A decorated
 * `export default class` counts as unexported: it has no named binding to import.
 */
export function parseDecoratedClasses(text: string): DecoratedClasses {
  const exported: string[] = []
  const unexported: string[] = []

  let index = 0
  let braceDepth = 0
  let decorated = false
  let isExport = false
  let isDefault = false

  function reset(): void {
    decorated = false
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
      index = skipDecorator(text, index)
      decorated = true
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
      if (decorated) {
        if (isExport && !isDefault && name) {
          exported.push(name)
        } else {
          unexported.push(name || 'default')
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

  return { exported, unexported }
}

export function parseRelativeImports(text: string): string[] {
  const specs: string[] = []
  const seen = new Set<string>()

  const fromRe = new RegExp(FROM_SRC, 'g')
  let match: RegExpExecArray | null
  while ((match = fromRe.exec(text)) !== null) {
    if (match[2]) {
      continue
    }
    addSpec(specs, seen, match[4])
  }

  const sideRe = new RegExp(SIDE_SRC, 'g')
  while ((match = sideRe.exec(text)) !== null) {
    addSpec(specs, seen, match[1])
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

// Skips `@Name.Ns(...)` including nested parens, strings and comments inside the argument list,
// so `@Controller('/cats', [Svc])` and `@Injectable(token<T>('x'))` both terminate correctly.
function skipDecorator(text: string, start: number): number {
  let index = start + 1
  while (index < text.length && (isIdentPart(text[index]) || text[index] === '.')) {
    index++
  }
  const parenStart = skipSpace(text, index)
  if (text[parenStart] !== '(') {
    return index
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
        return index + 1
      }
    }
    index++
  }
  return index
}

function skipString(text: string, start: number): number {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (quote === '`' && char === '$' && text[index + 1] === '{') {
      index = skipTemplateExpression(text, index + 1)
      continue
    }
    if (char === quote) {
      return index + 1
    }
    index++
  }
  return index
}

function skipTemplateExpression(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index)
      continue
    }
    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        return index + 1
      }
    }
    index++
  }
  return index
}

function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start)
  return end === -1 ? text.length : end + 1
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2)
  return end === -1 ? text.length : end + 2
}

function skipSpace(text: string, start: number): number {
  let index = start
  while (index < text.length && /\s/u.test(text[index])) {
    index++
  }
  return index
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/u.test(char)
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char)
}

function addSpec(specs: string[], seen: Set<string>, spec: string): void {
  if (!spec.startsWith('.') || seen.has(spec)) {
    return
  }
  seen.add(spec)
  specs.push(spec)
}
