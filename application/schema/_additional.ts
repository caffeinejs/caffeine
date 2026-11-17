import { type TSchema, TypeGuard } from '@sinclair/typebox'

/** A failure of a compiled validator: its path as segments, so a key holding a dot or a slash stays one segment. */
export interface CompiledIssue {
  readonly message: string
  readonly path: readonly string[]
  /** The JSON Schema keyword the value broke, such as `minLength`, or `decode` for a codec that refused it. */
  readonly code: string
}

/** What a compiled validator answers for one value. */
export type CompiledResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: CompiledIssue }

// Handles the keys an object does not declare in `properties` as Ajv's `removeAdditional` does, which TypeBox's
// `Value.Clean` does not: Clean drops every undeclared key everywhere, so a value validated here would lose data that
// a value validated by Ajv keeps.
//
// - A key a `patternProperties` pattern matches stays. On an object TypeBox checks, it is checked against that
//   pattern's schema there: TypeBox's object check ignores `patternProperties`, so such an object reaches TypeBox open
//   and its keys are validated here, each by its pattern's compiled validator. That validator converts and checks the
//   value, as Ajv does, but never decodes it: TypeBox's object type has no such key, and decodes none. A `$t.Record` is
//   TypeBox's own to check.
// - A key nothing matches is dropped under `additionalProperties: false`, at any depth, and checked against an
//   `additionalProperties` schema.
//
// A nullable object counts as the object, as HTTP's `normalizeForAjv` collapses it for Ajv. Inside any other union, or
// an intersection, nothing is dropped, since Ajv's own result there depends on the branch it tried first, and an object
// is left to TypeBox as written.

type Node = Record<string, unknown>
type Validate = (input: unknown) => CompiledResult
type Compile = (schema: TSchema, decode: boolean) => Validate

interface Pattern {
  regex: RegExp
  schema: Node
  // Set on an object TypeBox checks, whose matching keys are validated here.
  validate?: Validate
}

interface Rules {
  patterns: Pattern[]
  // A key no pattern matches, on an object TypeBox checks open, against an `additionalProperties` schema.
  additional?: Validate
}

export interface Additional {
  // What TypeBox checks, decodes, defaults and converts with: every object whose pattern keys are validated here open.
  schema: TSchema
  // Drops and validates the keys of `value`, in place; the first issue, if any.
  apply: (value: unknown) => CompiledIssue | undefined
}

export function compileAdditional(schema: TSchema, compile: Compile): Additional {
  const rules = new WeakMap<Node, Rules>()
  const opened = prepare(schema as Node, rules, compile)
  const apply = needsWalk(schema)
    ? (value: unknown) => visit(schema as Node, value, rules)
    : (_value: unknown): CompiledIssue | undefined => undefined
  return { schema: opened as TSchema, apply }
}

// Records the rules of every object declaring `patternProperties` that `visit` reaches, and returns a copy of what it
// walks with the objects TypeBox checks among them opened.
function prepare(node: Node, rules: WeakMap<Node, Rules>, compile: Compile): Node {
  const each = (child: unknown): Node => prepare(child as Node, rules, compile)
  // Spread keeps the TypeBox kind symbols.
  const copy: Node = { ...node }

  for (const key of ['properties', 'patternProperties']) {
    const record = node[key]
    if (isNode(record)) {
      copy[key] = Object.fromEntries(Object.entries(record).map(([name, child]) => [name, each(child)]))
    }
  }
  const { additionalProperties, items, patternProperties } = node
  if (isNode(additionalProperties)) {
    copy.additionalProperties = each(additionalProperties)
  }
  if (Array.isArray(items)) {
    copy.items = items.map(each)
  } else if (isNode(items)) {
    copy.items = each(items)
  }
  const nullable = nullableBranch(node)
  if (nullable !== undefined) {
    copy.anyOf = (node.anyOf as unknown[]).map(branch => (branch === nullable ? each(branch) : branch))
  }

  if (!isNode(patternProperties)) {
    return copy
  }

  const checksHere = TypeGuard.IsObject(node)
  rules.set(node, {
    patterns: Object.entries(patternProperties).map(([pattern, schema]) => ({
      // As Ajv builds a pattern.
      regex: new RegExp(pattern, 'u'),
      schema: schema as Node,
      validate: checksHere ? compile(schema as TSchema, false) : undefined,
    })),
    additional: checksHere && isNode(additionalProperties) ? compile(additionalProperties as TSchema, true) : undefined,
  })

  if (!checksHere) {
    return copy
  }
  // What TypeBox sees: the object open.
  const { patternProperties: _patterns, additionalProperties: _additional, ...open } = copy
  return open
}

function visit(schema: Node, value: unknown, rules: WeakMap<Node, Rules>): CompiledIssue | undefined {
  const nullable = nullableBranch(schema)
  if (nullable !== undefined) {
    return visit(nullable, value, rules)
  }

  if (Array.isArray(value)) {
    return visitItems(schema.items, value, rules)
  }

  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const record = value as Record<string, unknown>
  const known = rules.get(schema)
  for (const key of Object.keys(record)) {
    const issue = visitKey(schema, known, record, key, rules)
    if (issue !== undefined) {
      return under(key, issue)
    }
  }
  return undefined
}

// One key of an object: one `properties` declares, one a pattern matches, or one neither does. An issue's path is
// below the key.
function visitKey(
  schema: Node,
  known: Rules | undefined,
  record: Record<string, unknown>,
  key: string,
  rules: WeakMap<Node, Rules>,
): CompiledIssue | undefined {
  const { properties, additionalProperties } = schema
  if (isNode(properties) && Object.hasOwn(properties, key)) {
    return visit(properties[key] as Node, record[key], rules)
  }

  const matching = known === undefined ? [] : known.patterns.filter(pattern => pattern.regex.test(key))
  if (matching.length > 0) {
    return visitPatterns(matching, record, key, rules)
  }

  if (additionalProperties === false) {
    delete record[key]
    return undefined
  }
  if (known?.additional !== undefined) {
    return run(known.additional, record, key)
  }
  return isNode(additionalProperties) ? visit(additionalProperties, record[key], rules) : undefined
}

// A key against every pattern that matches it, in turn; the first issue, if any.
function visitPatterns(
  matching: Pattern[],
  record: Record<string, unknown>,
  key: string,
  rules: WeakMap<Node, Rules>,
): CompiledIssue | undefined {
  for (const pattern of matching) {
    const issue =
      pattern.validate === undefined ? visit(pattern.schema, record[key], rules) : run(pattern.validate, record, key)
    if (issue !== undefined) {
      return issue
    }
  }
  return undefined
}

// The items of an array, each against its schema: the one `items` gives every item, or a tuple's own, past whose end
// an item has none.
function visitItems(items: unknown, value: unknown[], rules: WeakMap<Node, Rules>): CompiledIssue | undefined {
  for (let i = 0; i < value.length; i++) {
    const item = Array.isArray(items) ? items[i] : items
    const issue = isNode(item) ? visit(item, value[i], rules) : undefined
    if (issue !== undefined) {
      return under(String(i), issue)
    }
  }
  return undefined
}

// Validates `record[key]` with `validate`, writing back what it produced; the first issue, if any.
function run(validate: Validate, record: Record<string, unknown>, key: string): CompiledIssue | undefined {
  const result = validate(record[key])
  if (!result.ok) {
    return result.issue
  }
  record[key] = result.value
  return undefined
}

// The issue of a value below `segment`: its path is built only once an issue arises, so a value that passes allocates
// none.
function under(segment: string, issue: CompiledIssue): CompiledIssue {
  return { ...issue, path: [segment, ...issue.path] }
}

// Whether anything in `schema` is for this walk to handle: a closed object, an `additionalProperties` schema, or
// `patternProperties`. A schema with none of them is not walked at all.
function needsWalk(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(needsWalk)
  }
  if (!isNode(node)) {
    return false
  }
  const { additionalProperties, patternProperties } = node
  if (additionalProperties === false || isNode(additionalProperties) || isNode(patternProperties)) {
    return true
  }
  return Object.values(node).some(needsWalk)
}

// The other branch of `anyOf: [X, { type: 'null' }]`, in either order.
function nullableBranch(schema: Node): Node | undefined {
  const { anyOf } = schema
  if (!Array.isArray(anyOf) || anyOf.length !== 2) {
    return undefined
  }

  const [first, second] = anyOf as Node[]
  if (isNullOnly(second)) {
    return first
  }
  return isNullOnly(first) ? second : undefined
}

function isNullOnly(schema: Node): boolean {
  return schema.type === 'null' && Object.keys(schema).length === 1
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
