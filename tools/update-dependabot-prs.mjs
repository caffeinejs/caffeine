#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  return `Usage: node tools/update-dependabot-prs.mjs [--lockfile] [pr...]

pr          PR number or GitHub pull URL (repeatable)
            omit to update every open Dependabot PR
--lockfile  merge origin/main, npm install, commit lockfile if needed, push
            default: comment @dependabot recreate
`
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
    env: process.env,
  })

  if (result.error?.code === 'ENOENT') {
    throw new Error(`Command not found: ${cmd}`)
  }

  if ((result.status ?? 1) !== 0 && opts.allowFail !== true) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
  }

  return result
}

function parseArgs(argv) {
  let lockfile = false
  const refs = []

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    }
    if (arg === '--lockfile') {
      lockfile = true
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n${usage()}`)
    }
    refs.push(arg)
  }

  return { lockfile, refs }
}

function parsePrRef(raw) {
  if (/^\d+$/.test(raw)) {
    return Number(raw)
  }

  const match = raw.match(/\/pull\/(\d+)/)
  if (match) {
    return Number(match[1])
  }

  throw new Error(`Not a PR number or URL: ${raw}`)
}

function requireGh() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT' || (result.status ?? 1) !== 0) {
    throw new Error('gh is required (https://cli.github.com/)')
  }
}

function listOpenDependabotPrs() {
  const result = run('gh', ['pr', 'list', '--author', 'app/dependabot', '--state', 'open', '--json', 'number'])
  const rows = JSON.parse(result.stdout || '[]')
  return rows.map(row => row.number)
}

function assertDependabotPr(number) {
  const result = run('gh', ['pr', 'view', String(number), '--json', 'author'])
  const login = JSON.parse(result.stdout).author?.login ?? ''

  if (!/dependabot/i.test(login)) {
    throw new Error(`PR #${number} is not a Dependabot PR (author: ${login || 'unknown'})`)
  }
}

function recreate(number) {
  run('gh', ['pr', 'comment', String(number), '--body', '@dependabot recreate'], { stdio: 'inherit' })
}

function gitStdout(args) {
  return (run('git', args).stdout || '').trim()
}

function worktreeDirty() {
  return gitStdout(['status', '--porcelain']) !== ''
}

function unmergedFiles() {
  return gitStdout(['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function mergeMain() {
  const merge = run('git', ['merge', 'origin/main', '--no-edit'], { allowFail: true, stdio: 'inherit' })
  if ((merge.status ?? 1) === 0) {
    return
  }

  const unmerged = unmergedFiles()
  const others = unmerged.filter(file => file !== 'package-lock.json')
  if (unmerged.includes('package-lock.json') && others.length === 0) {
    run('git', ['checkout', '--theirs', 'package-lock.json'], { stdio: 'inherit' })
    run('git', ['add', 'package-lock.json'])
    if (unmergedFiles().length > 0) {
      run('git', ['merge', '--abort'], { allowFail: true })
      throw new Error('package-lock.json conflict could not be resolved')
    }
    run('git', ['commit', '--no-edit'], { stdio: 'inherit' })
    return
  }

  run('git', ['merge', '--abort'], { allowFail: true })
  if (unmerged.length > 0) {
    throw new Error(`merge conflict: ${unmerged.join(', ')}`)
  }

  const detail = (merge.stderr || merge.stdout || '').trim()

  throw new Error(`git merge origin/main failed${detail ? `\n${detail}` : ''}`)
}

function lockfileChanged() {
  const diff = run('git', ['diff', '--quiet', '--', 'package-lock.json'], { allowFail: true })
  const staged = run('git', ['diff', '--quiet', '--cached', '--', 'package-lock.json'], { allowFail: true })
  return diff.status === 1 || staged.status === 1
}

function repairLockfile(number) {
  run('gh', ['pr', 'checkout', String(number)], { stdio: 'inherit' })
  mergeMain()
  run('npm', ['install'], { stdio: 'inherit' })

  if (lockfileChanged()) {
    run('git', ['add', '--', 'package-lock.json'])
    run('git', ['commit', '-m', 'chore: refresh package-lock.json'], { stdio: 'inherit' })
  }

  run('git', ['push'], { stdio: 'inherit' })
}

function restoreRef(ref) {
  if (!ref) {
    return
  }

  run('git', ['checkout', ref], { stdio: 'inherit', allowFail: true })
}

function main() {
  const { lockfile, refs } = parseArgs(process.argv.slice(2))

  requireGh()

  const numbers = refs.length > 0 ? refs.map(parsePrRef) : listOpenDependabotPrs()
  if (numbers.length === 0) {
    process.stdout.write('No open Dependabot PRs.\n')
    return
  }

  let originalRef = ''
  if (lockfile) {
    if (worktreeDirty()) {
      throw new Error('Working tree is dirty. Commit or stash before --lockfile.')
    }
    originalRef = gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (originalRef === 'HEAD') {
      originalRef = gitStdout(['rev-parse', 'HEAD'])
    }
    run('git', ['fetch', 'origin'], { stdio: 'inherit' })
  }

  const failures = []
  try {
    for (const number of numbers) {
      process.stdout.write(`\nPR #${number}\n`)
      try {
        assertDependabotPr(number)
        if (lockfile) {
          repairLockfile(number)
        } else {
          recreate(number)
        }
      } catch (err) {
        failures.push(`#${number}: ${err instanceof Error ? err.message : err}`)
        process.stderr.write(`${failures.at(-1)}\n`)
      }
    }
  } finally {
    if (lockfile) {
      restoreRef(originalRef)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed ${failures.length} PR(s):\n${failures.join('\n')}`)
  }
}

try {
  main()
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`)
  process.exit(1)
}
