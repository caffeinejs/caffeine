import type { IContext } from '../../context.js'
import type { Problem } from './problem.js'

// What a machine reads goes in the frontmatter, in this order; extensions follow. The rest is prose, in sections.
const FRONTMATTER = ['type', 'title', 'status', 'code', 'category', 'instance', 'correlation_id', 'timestamp']
const SECTIONS = new Set(['detail', 'what_you_should_do', 'errors', 'stacktrace'])

// Every character some reader ends a line on: JavaScript's multiline anchors and YAML 1.1 count the last three.
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/
const SEPARATORS = /[\u0085\u2028\u2029]/g

// Words YAML 1.1 reads as a boolean or null, which a key must not be spelled as to come back as a string.
const YAML_KEYWORD = /^(?:y|n|yes|no|true|false|on|off|null)$/i

/**
 * Renders a {@link Problem} as Markdown: YAML frontmatter with the members a client branches on, then the title,
 * `What happened`, `What you should do`, `Errors` and `Stack trace` sections, each only when its member is there.
 *
 * Every frontmatter value is JSON, which YAML reads as is, and text from the problem is escaped so that it cannot
 * open a heading, a fence or a frontmatter block of its own.
 */
export function problemMarkdown(_ctx: IContext, problem: Problem): string {
  const fields = [
    ...FRONTMATTER.filter(name => name in problem),
    ...Object.keys(problem).filter(name => !FRONTMATTER.includes(name) && !SECTIONS.has(name)),
  ]
  const front = fields.flatMap(name => {
    const value = JSON.stringify(problem[name])
    return value === undefined ? [] : [`${yamlKey(name)}: ${escapeSeparators(value)}`]
  })

  const lines = [
    '---',
    ...front,
    '---',
    '',
    `# ${inline(problem.title)}`,
    '',
    '## What happened',
    '',
    block(problem.detail),
  ]

  if (problem.what_you_should_do !== undefined) {
    lines.push('', '## What you should do', '', block(problem.what_you_should_do))
  }

  if (problem.errors !== undefined && problem.errors.length > 0) {
    lines.push('', '## Errors', '')
    for (const issue of problem.errors) {
      const rule = issue.code === undefined ? '' : ` (${inline(issue.code)})`
      lines.push(`- ${codeSpan(issue.path)}${rule}: ${inline(issue.message)}`)
    }
  }

  if (problem.stacktrace !== undefined) {
    const fence = '`'.repeat(Math.max(3, longestRun(problem.stacktrace, '`') + 1))
    lines.push('', '## Stack trace', '', `${fence}text`, ...problem.stacktrace.split(LINE_BREAK), fence)
  }

  return `${lines.join('\n')}\n`
}

function yamlKey(name: string): string {
  return /^[A-Za-z_][\w-]*$/.test(name) && !YAML_KEYWORD.test(name) ? name : escapeSeparators(JSON.stringify(name))
}

// JSON leaves these as they are, and a reader that breaks lines on them would see the value end there.
function escapeSeparators(json: string): string {
  return json.replace(SEPARATORS, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// One line, for a heading or a list item: a line break there would end it and start a block of the text's own.
function inline(text: string): string {
  return text.replace(/\s*(?:\r\n|[\r\n\u0085\u2028\u2029])\s*/g, ' ')
}

// A character that opens a block at the start of a line — a heading, a fence, a quote, a list, a thematic break
// or a setext underline, the `---` of frontmatter among them — is escaped there, and reads as itself.
function block(text: string): string {
  return text
    .split(LINE_BREAK)
    .map(line => line.replace(/^(\s*)([#>`~=+*_|<-])/, '$1\\$2'))
    .join('\n')
}

function codeSpan(text: string): string {
  const content = inline(text)
  const fence = '`'.repeat(longestRun(content, '`') + 1)
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${content}${pad}${fence}`
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const c of text) {
    run = c === char ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}
