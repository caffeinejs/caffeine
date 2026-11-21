import { KiB } from '@caffeinejs/std/bytes'
import { errMessage } from '@caffeinejs/std/err'
import { defaultTreeAdapter, parseFragment, serialize } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'

import { ErrTemplateConfiguration, ErrTemplateLimit } from '../errors.js'
import { isHTTPSURL } from './url.js'
import type { HTTPSURL } from './url.js'

type Node = DefaultTreeAdapterTypes.ChildNode
type Parent = DefaultTreeAdapterTypes.ParentNode
type Fragment = DefaultTreeAdapterTypes.DocumentFragment

declare const safeHTMLBrand: unique symbol

/** Markup produced by the HTML tag or explicitly trusted through {@link unsafeHTML}. */
export interface SafeHTML {
  readonly [safeHTMLBrand]: true
  toString(): string
}

export type HTMLValue = string | number | boolean | null | undefined | SafeHTML | HTTPSURL | readonly HTMLValue[]

interface CompiledHTML {
  tree: Fragment
  marker: RegExp
}

const fragments = new WeakMap<object, string>()
const templates = new WeakMap<TemplateStringsArray, CompiledHTML>()
const encoder = new TextEncoder()
const maxLiteral = 64 * KiB
const maxOutput = 512 * KiB
const maxDepth = 128
const maxNodes = 16_384
const htmlNamespace = 'http://www.w3.org/1999/xhtml'
const blockedText = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'noscript',
  'template',
])
const textAttributes = new Set(['title', 'alt', 'aria-label'])
const urlAttributes = new Set(['href', 'src'])
const tableRows = ['tr', 'script', 'template']
const tableChildren = new Map<string, readonly string[]>([
  ['table', ['caption', 'colgroup', 'tbody', 'thead', 'tfoot', 'script', 'template', 'style']],
  ['tbody', tableRows],
  ['thead', tableRows],
  ['tfoot', tableRows],
  ['tr', ['td', 'th', 'script', 'template']],
  ['colgroup', ['col', 'template']],
])
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function configuration(reason: string): never {
  throw new ErrTemplateConfiguration(
    errMessage(`Cannot render inline HTML: ${reason}`)
      .solutions(
        'Place interpolations in normal text, quoted title, alt or aria-label attributes, or a complete quoted href or src',
      )
      .build(),
  )
}

function limit(reason: string): never {
  throw new ErrTemplateLimit(`Cannot render inline HTML: ${reason}`)
}

function checkTableText(value: string, parent: Parent): void {
  if (defaultTreeAdapter.isElementNode(parent) && tableChildren.has(parent.tagName) && /[^\t\n\f\r ]/.test(value)) {
    configuration('table structure slots require HTML whitespace or branded structural fragments')
  }
}

function checkSize(value: string, maximum: number): void {
  if (value.length > maximum || encoder.encode(value).byteLength > maximum) {
    limit(`content exceeds ${maximum} bytes`)
  }
}

function branded(value: string): SafeHTML {
  checkSize(value, maxOutput)
  const result = Object.freeze({ toString: () => value }) as SafeHTML
  fragments.set(result, value)
  return result
}

export function isSafeHTML(value: unknown): value is SafeHTML {
  return typeof value === 'object' && value !== null && fragments.has(value)
}

/** Trusts application-owned markup without escaping or sanitizing it. Never pass untrusted input. */
export function unsafeHTML(input: string): SafeHTML {
  if (typeof input !== 'string') {
    throw new TypeError('Cannot trust HTML: expected a string')
  }
  return branded(input)
}

function walk(tree: Parent, visit?: (node: Node, blocked: boolean) => void): void {
  let count = 0
  function children(parent: Parent, blocked: boolean, depth: number): void {
    if (depth > maxDepth) {
      limit('HTML tree nesting exceeds 128 levels')
    }
    for (const node of parent.childNodes) {
      if (++count > maxNodes) {
        limit('HTML tree exceeds 16384 nodes')
      }
      const element = defaultTreeAdapter.isElementNode(node)
      const unsafe = blocked || (element && (node.namespaceURI !== htmlNamespace || blockedText.has(node.tagName)))
      visit?.(node, unsafe)
      if (element) {
        children(node, unsafe, depth + 1)
        if (node.tagName === 'template' && 'content' in node) {
          children(defaultTreeAdapter.getTemplateContent(node), true, depth + 1)
        }
      }
    }
  }
  children(tree, false, 0)
}

function validateStructure(tree: Fragment, source: string): void {
  const tokens: Array<{ start: number; end: number; node: Node; parent?: Node; kind: 'start' | 'end' | 'content' }> = []
  function children(parent: Parent, authoredParent?: Node): void {
    for (const node of parent.childNodes) {
      const location = node.sourceCodeLocation
      if (defaultTreeAdapter.isElementNode(node)) {
        let nextParent = authoredParent
        if (location && 'startTag' in location && location.startTag) {
          const { startTag, endTag } = location
          const isVoid = node.namespaceURI === htmlNamespace && voidElements.has(node.tagName)
          if (!isVoid && !endTag) {
            configuration('nonvoid elements require explicit balanced closing tags')
          }
          tokens.push({
            start: startTag.startOffset,
            end: startTag.endOffset,
            node,
            parent: authoredParent,
            kind: isVoid ? 'content' : 'start',
          })
          if (endTag) {
            tokens.push({ start: endTag.startOffset, end: endTag.endOffset, node, kind: 'end' })
          }
          nextParent = node
        }
        children(node, nextParent)
        if (node.tagName === 'template' && 'content' in node) {
          children(defaultTreeAdapter.getTemplateContent(node), nextParent)
        }
      } else if (location) {
        if (
          defaultTreeAdapter.isTextNode(node) &&
          !(
            authoredParent &&
            defaultTreeAdapter.isElementNode(authoredParent) &&
            blockedText.has(authoredParent.tagName)
          ) &&
          /<(?:\/?[A-Za-z]|!|\?)/.test(source.slice(location.startOffset, location.endOffset))
        ) {
          configuration('the static fragment contains discarded or relocated markup')
        }
        tokens.push({
          start: location.startOffset,
          end: location.endOffset,
          node,
          parent: authoredParent,
          kind: 'content',
        })
      }
    }
  }
  children(tree)
  tokens.sort((a, b) => a.start - b.start)
  const stack: Node[] = []
  let offset = 0
  for (const token of tokens) {
    if (token.start !== offset || (token.kind === 'end' ? stack.pop() !== token.node : stack.at(-1) !== token.parent)) {
      configuration('the static fragment contains unbalanced or relocated markup')
    }
    if (token.kind === 'start') {
      stack.push(token.node)
    }
    offset = token.end
  }
  if (offset !== source.length || stack.length !== 0) {
    configuration('the static fragment contains discarded or unbalanced markup')
  }
}

function compile(strings: TemplateStringsArray): CompiledHTML {
  if (strings.length > maxNodes) {
    limit('HTML interpolations exceed 16383 slots')
  }
  let size = 0
  for (const literal of strings) {
    if (literal.length > maxLiteral) {
      limit('HTML literals exceed 65536 bytes')
    }
    size += encoder.encode(literal).byteLength
    if (size > maxLiteral) {
      limit('HTML literals exceed 65536 bytes')
    }
  }

  let sequence = 0
  let prefix: string
  do {
    prefix = `caffeine-slot-${sequence++}x-`
  } while (strings.some(literal => literal.toLowerCase().includes(prefix)))
  const marker = new RegExp(`<!--${prefix}(\\d+)-z-->`, 'g')
  const offsets: number[] = []
  let source = strings[0]
  for (let index = 1; index < strings.length; index++) {
    offsets.push(source.length)
    source += `<!--${prefix}${index - 1}-z-->${strings[index]}`
  }

  const tree = parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: () => configuration('the static fragment is malformed'),
  })
  walk(tree)
  validateStructure(tree, source)
  const found = new Set<number>()
  function check(value: string, start: number, end: number, blocked: boolean): void {
    for (const match of value.matchAll(marker)) {
      const index = Number(match[1])
      const offset = offsets[index]
      if (
        blocked ||
        offset === undefined ||
        found.has(index) ||
        offset < start ||
        offset + match[0].length > end ||
        source.slice(offset, offset + match[0].length) !== match[0]
      ) {
        configuration('an interpolation occupies an unsafe or ambiguous context')
      }
      found.add(index)
    }
  }
  walk(tree, (node, blocked) => {
    if (defaultTreeAdapter.isCommentNode(node)) {
      const location = node.sourceCodeLocation
      check(`<!--${node.data}-->`, location?.startOffset ?? -1, location?.endOffset ?? -1, blocked)
    } else if (defaultTreeAdapter.isTextNode(node)) {
      const location = node.sourceCodeLocation
      check(node.value, location?.startOffset ?? -1, location?.endOffset ?? -1, blocked)
    } else if (defaultTreeAdapter.isElementNode(node)) {
      for (const attr of node.attrs) {
        if (!marker.test(attr.value)) {
          marker.lastIndex = 0
          continue
        }
        marker.lastIndex = 0
        const location = node.sourceCodeLocation?.attrs?.[attr.name]
        const raw = location && source.slice(location.startOffset, location.endOffset)
        const quoted = raw && /^[^\s=]+\s*=\s*(["'])([\s\S]*)\1$/.exec(raw)
        if (!quoted || (!textAttributes.has(attr.name) && !urlAttributes.has(attr.name))) {
          configuration('an attribute interpolation requires an allowed quoted attribute')
        }
        if (urlAttributes.has(attr.name) && !new RegExp(`^<!--${prefix}\\d+-z-->$`).test(attr.value)) {
          configuration('a URL interpolation must occupy the whole quoted attribute value')
        }
        check(attr.value, location!.startOffset, location!.endOffset, blocked)
      }
    }
  })
  if (found.size !== offsets.length) {
    configuration('an interpolation occupies an unsupported HTML context')
  }
  return { tree, marker }
}

function scalar(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  throw new TypeError(
    'Cannot render inline HTML: expected a scalar or branded HTML in text, or an HTTPS URL in a URL attribute',
  )
}

/**
 * Escapes text and allowed quoted attributes, and inserts branded fragments as isolated nodes.
 *
 * Static markup requires explicit balanced closing tags for nonvoid elements. Parser repairs that relocate markup
 * are rejected; implicit table containers are allowed. Literal text is limited to 64 KiB and output to 512 KiB.
 * Table structure slots accept HTML whitespace or branded fragments; nonwhitespace text would relocate on parsing.
 */
export function html(strings: TemplateStringsArray, ...values: HTMLValue[]): SafeHTML {
  if (
    !Array.isArray(strings) ||
    !Object.isFrozen(strings) ||
    !Array.isArray(strings.raw) ||
    !Object.isFrozen(strings.raw) ||
    strings.length !== values.length + 1 ||
    !strings.every(value => typeof value === 'string')
  ) {
    throw new TypeError('Cannot render inline HTML: use html as a template tag')
  }
  let compiled = templates.get(strings)
  if (!compiled) {
    compiled = compile(strings)
    templates.set(strings, compiled)
  }

  const tree = structuredClone(compiled.tree)
  const { marker } = compiled
  let size = 0
  const active = new Set<readonly HTMLValue[]>()
  function addSize(value: string): void {
    checkSize(value, maxOutput)
    size += encoder.encode(value).byteLength
    if (size > maxOutput) {
      limit('HTML interpolations exceed 524288 bytes')
    }
  }
  function text(value: HTMLValue, parent: Parent, depth = 0): Node[] {
    if (Array.isArray(value)) {
      if (depth >= 32 || active.has(value)) {
        limit('HTML arrays contain a cycle or exceed 32 nesting levels')
      }
      active.add(value)
      const result: Node[] = []
      for (const item of value) {
        result.push(...text(item, parent, depth + 1))
        if (result.length > maxNodes) {
          limit('HTML tree exceeds 16384 nodes')
        }
      }
      active.delete(value)
      return result
    }
    if (isSafeHTML(value)) {
      const markup = fragments.get(value)!
      addSize(markup)
      const fragment = parseFragment(parent, markup, {})
      walk(fragment, node => {
        const container = node.parentNode === fragment ? parent : node.parentNode!
        if (defaultTreeAdapter.isTextNode(node)) {
          checkTableText(node.value, container)
        } else if (defaultTreeAdapter.isElementNode(node) && defaultTreeAdapter.isElementNode(container)) {
          const allowed = tableChildren.get(container.tagName)
          if (allowed !== undefined && !allowed.includes(node.tagName)) {
            configuration('a branded fragment would move outside its table structure slot')
          }
        }
      })
      for (const node of fragment.childNodes) {
        node.parentNode = parent
      }
      return fragment.childNodes
    }
    const output = scalar(value)
    checkTableText(output, parent)
    addSize(output)
    return output === '' ? [] : [{ nodeName: '#text', value: output, parentNode: parent }]
  }

  // Collect before insertion: a trusted fragment cannot introduce another interpolation.
  const nodes: Node[] = []
  walk(tree, node => nodes.push(node))
  for (const node of nodes) {
    if (defaultTreeAdapter.isCommentNode(node)) {
      const match = [...`<!--${node.data}-->`.matchAll(marker)][0]
      if (match) {
        const parent = node.parentNode!
        parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...text(values[Number(match[1])], parent))
      }
    } else if (defaultTreeAdapter.isTextNode(node)) {
      const matches = [...node.value.matchAll(marker)]
      if (matches.length === 0) {
        continue
      }
      const parent = node.parentNode!
      const replacement: Node[] = []
      let position = 0
      for (const match of matches) {
        replacement.push(...text(node.value.slice(position, match.index), parent))
        replacement.push(...text(values[Number(match[1])], parent))
        position = match.index + match[0].length
      }
      replacement.push(...text(node.value.slice(position), parent))
      parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...replacement)
    } else if (defaultTreeAdapter.isElementNode(node)) {
      for (const attr of node.attrs) {
        attr.value = attr.value.replace(marker, (_match, index: string) => {
          const value = values[Number(index)]
          if (urlAttributes.has(attr.name)) {
            if (!isHTTPSURL(value)) {
              throw new TypeError('Cannot render inline HTML: href and src require httpsURL')
            }
            const output = value.toString()
            addSize(output)
            return output
          }
          const output = scalar(value)
          addSize(output)
          return output
        })
      }
    }
  }
  walk(tree)
  return branded(serialize(tree))
}
