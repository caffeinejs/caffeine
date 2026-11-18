import { describe, expect, it } from 'vitest'

import type { IContext } from '../../context.js'
import {
  buildValidationProblem,
  ErrRequestValidation,
  isValidationSlot,
  standardIssue,
  type ValidationProblem,
} from './validation.js'

const ctx = {} as IContext
const settings: ValidationProblem = { type: 'about:blank', code: 'ERR_VALIDATION', maxErrors: 25 }
const entry = (detail: string) => ({ code: 'ERR_VALIDATION', detail })

describe('standardIssue', () => {
  it('points a body issue at its JSON pointer and names the keyword in the code', () => {
    expect(standardIssue('body', { message: 'm', path: ['items', 0, 'name'], code: 'minLength' })).toEqual({
      code: 'ERR_VALIDATION_MIN_LENGTH',
      detail: 'name m',
      source: { in: 'body', pointer: '/items/0/name' },
    })
  })

  it('names the query parameter of a querystring issue', () => {
    expect(standardIssue('querystring', { message: 'm', path: ['page'] })).toEqual({
      code: 'ERR_VALIDATION',
      detail: 'page m',
      source: { in: 'query', name: 'page' },
    })
  })

  it('escapes a slash in a path key so the pointer stays one segment', () => {
    const issue = standardIssue('body', { message: 'm', path: [{ key: 'a/b' }] })

    expect(issue.source).toEqual({ in: 'body', pointer: '/a~1b' })
    expect(issue.detail).toBe('a/b m')
  })

  it('keeps the bare message and an empty pointer for an issue with no path', () => {
    const issue = standardIssue('body', { message: 'm' })

    expect(issue.detail).toBe('m')
    expect(issue.source).toEqual({ in: 'body', pointer: '' })
  })
})

describe('buildValidationProblem', () => {
  it('answers 422 for the body and 400 for the other slots', () => {
    expect(buildValidationProblem(ctx, 'body', [], 0, settings, () => {}).status).toBe(422)
    expect(buildValidationProblem(ctx, 'params', [], 0, settings, () => {}).status).toBe(400)
  })

  it('says how many errors the list leaves out', () => {
    const problem = buildValidationProblem(
      ctx,
      'body',
      [entry('a'), entry('b')],
      3,
      { ...settings, maxErrors: 2 },
      () => {},
    )

    expect(problem.detail).toBe('Invalid request body: showing the first 2 of 3 errors')
  })

  it('takes type, title and code from the settings', () => {
    const problem = buildValidationProblem(
      ctx,
      'body',
      [],
      0,
      { type: 'https://example.com/invalid', title: 'Bad input', code: 'ERR_BAD_INPUT', maxErrors: 25 },
      () => {},
    )

    expect(problem.type).toBe('https://example.com/invalid')
    expect(problem.title).toBe('Bad input')
    expect(problem.code).toBe('ERR_BAD_INPUT')
  })

  it('applies the issue mapper to each entry', () => {
    const problem = buildValidationProblem(
      ctx,
      'body',
      [entry('a'), entry('b')],
      2,
      { ...settings, issue: (_ctx, issue) => ({ ...issue, detail: `mapped ${issue.detail}` }) },
      () => {},
    )

    expect(problem.errors).toEqual([entry('mapped a'), entry('mapped b')])
  })

  it('sends the rest as built and reports once when the mapper throws', () => {
    const failure = new Error('boom')
    const failures: unknown[] = []
    let calls = 0
    const problem = buildValidationProblem(
      ctx,
      'body',
      [entry('a'), entry('b'), entry('c')],
      3,
      {
        ...settings,
        issue: (_ctx, issue) => {
          calls++
          if (calls === 2) {
            throw failure
          }
          return { ...issue, detail: `mapped ${issue.detail}` }
        },
      },
      err => failures.push(err),
    )

    expect(problem.errors).toEqual([entry('mapped a'), entry('b'), entry('c')])
    expect(failures).toEqual([failure])
  })
})

describe('isValidationSlot', () => {
  it('accepts the four slots and nothing else', () => {
    expect(isValidationSlot('querystring')).toBe(true)
    expect(isValidationSlot('cookies')).toBe(false)
    expect(isValidationSlot(1)).toBe(false)
  })
})

describe('ErrRequestValidation', () => {
  it('answers 400 for a slot other than the body', () => {
    const err = new ErrRequestValidation('headers', [], 'GET /x')

    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('ERR_REQUEST_VALIDATION')
    expect(err.name).toBe('ErrRequestValidation')
    expect(err.slot).toBe('headers')
  })

  // A record's keys are the client's, so a key quoted in the message is cut short.
  it('quotes at most 64 characters of each segment of the path', () => {
    const err = new ErrRequestValidation('body', [{ message: 'm', path: ['k'.repeat(100)] }], 'POST /pets')

    expect(err.message.split('\n')[0]).toBe(
      `Cannot accept the request body of "POST /pets": 1 error, the first at "${'k'.repeat(64)}…"`,
    )
  })

  it('answers 422 for the body', () => {
    expect(new ErrRequestValidation('body', [{ message: 'm' }], 'POST /pets').statusCode).toBe(422)
  })

  // A log line or a catch handler that keeps only the first line still knows where to look.
  it('names the route, the count and the first field in its first line', () => {
    const err = new ErrRequestValidation(
      'body',
      [
        { message: 'is too short', path: ['items', 0, 'name'], code: 'minLength' },
        { message: 'm', path: ['b'] },
      ],
      'POST /pets',
    )

    expect(err.message.split('\n')[0]).toBe(
      'Cannot accept the request body of "POST /pets": 2 errors, the first at "items/0/name", which breaks "minLength"',
    )
  })
})
