// Low-level text scanning shared by the hand-rolled decorator scanner (_module_graph_parse.ts) and
// the JSONC parser (_tsconfig_resolve.ts). Each skips forward from the start of a token and returns
// the index just past it.

export function skipString(text: string, start: number): number {
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

export function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start)
  return end === -1 ? text.length : end + 1
}

export function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2)
  return end === -1 ? text.length : end + 2
}

export function skipSpace(text: string, start: number): number {
  let index = start
  while (index < text.length && /\s/u.test(text[index])) {
    index++
  }
  return index
}
