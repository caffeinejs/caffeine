#!/usr/bin/env node
// Fails when a GitHub Action is not pinned to a commit SHA or a container image is not pinned to a digest.
// Scope and rationale: CONVENTIONS.md "Security".
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
const SHA1 = /^[0-9a-f]{40}$/
const DIGEST = /@sha256:[0-9a-f]{64}$/
const VERSION_COMMENT = /^#\s*v?\d+(\.\d+)*/

const violations = []

function report(file, line, ref) {
  violations.push(`Cannot accept unpinned reference: ${relative(root, file)}:${line} "${ref}"`)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(join(dir, entry.name))
      }
    } else if (entry.isFile()) {
      yield join(dir, entry.name)
    }
  }
}

function lines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/)
}

// GitHub Actions: `uses: owner/repo[/path]@<40-hex sha> # vX.Y.Z` or `uses: docker://image@sha256:<digest>`.
function checkWorkflow(file) {
  lines(file).forEach((text, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*['"]?([^'"#\s]+)['"]?\s*(#.*)?$/.exec(text)
    if (!m) {
      return
    }
    const [, ref, comment = ''] = m
    if (ref.startsWith('./')) {
      return
    }
    if (ref.startsWith('docker://')) {
      if (!DIGEST.test(ref)) {
        report(file, i + 1, ref)
      }
      return
    }
    const at = ref.lastIndexOf('@')
    const sha = at === -1 ? '' : ref.slice(at + 1)
    if (!SHA1.test(sha) || !VERSION_COMMENT.test(comment.trim())) {
      report(file, i + 1, ref)
    }
  })
}

// Dockerfiles: every `FROM` carries a digest, unless it names `scratch` or a stage declared earlier in the file.
function checkDockerfile(file) {
  const stages = new Set()
  lines(file).forEach((text, i) => {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(text)
    if (!m) {
      return
    }
    const [, ref, stage] = m
    if (stage) {
      stages.add(stage)
    }
    if (ref === 'scratch' || stages.has(ref) || ref.startsWith('$')) {
      return
    }
    if (!DIGEST.test(ref)) {
      report(file, i + 1, ref)
    }
  })
}

// Compose files: every `image:` under `services:` carries a digest, unless the service also declares `build:`.
function checkCompose(file) {
  const all = lines(file)
  let inServices = false
  let serviceIndent = -1
  let service = null

  const flush = () => {
    if (service && service.image && !service.build && !DIGEST.test(service.image.ref)) {
      report(file, service.image.line, service.image.ref)
    }
    service = null
  }

  all.forEach((text, i) => {
    if (/^\s*(#|$)/.test(text)) {
      return
    }
    const indent = text.length - text.trimStart().length
    if (indent === 0) {
      flush()
      inServices = /^services:\s*$/.test(text)
      serviceIndent = -1
      return
    }
    if (!inServices) {
      return
    }
    if (serviceIndent === -1) {
      serviceIndent = indent
    }
    if (indent === serviceIndent) {
      flush()
      service = { image: null, build: false }
      return
    }
    if (!service || indent <= serviceIndent) {
      return
    }
    const key = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(text)
    if (!key) {
      return
    }
    if (key[1] === 'build') {
      service.build = true
    } else if (key[1] === 'image') {
      const ref = key[2].replace(/^['"]|['"]\s*$/g, '').trim()
      service.image = { ref, line: i + 1 }
    }
  })
  flush()
}

for (const file of walk(root)) {
  const rel = relative(root, file).replaceAll('\\', '/')
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (rel.startsWith('.github/') && (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) || name === 'action.yml')) {
    checkWorkflow(file)
  } else if (name.startsWith('Dockerfile') && !name.endsWith('.dockerignore')) {
    checkDockerfile(file)
  } else if (/^(docker-)?compose[^/]*\.ya?ml$/.test(name)) {
    checkCompose(file)
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(v)
  }
  console.error('Pin every action to a commit SHA and every image to a digest (CONVENTIONS.md "Security")')
  process.exit(1)
}
