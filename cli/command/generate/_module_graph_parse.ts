const DECORATOR_RE = /(?:^|\n)\s*@[A-Za-z]/
const FROM_SRC = String.raw`(?:^|[\n;])\s*(import|export)(\s+type\b)?\s*([\s\S]{0,400}?)from\s+['"]([^'"]+)['"]`
const SIDE_SRC = String.raw`(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]`
const EXPORT_CONST_SRC = String.raw`export\s+const\s+(\w+)`

export function hasDecorator(text: string): boolean {
  return DECORATOR_RE.test(text)
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

function addSpec(specs: string[], seen: Set<string>, spec: string): void {
  if (!spec.startsWith('.') || seen.has(spec)) {
    return
  }
  seen.add(spec)
  specs.push(spec)
}
