import Negotiator from 'negotiator'

import type { IContext } from '../../context.js'
import { PROBLEM_CONTENT_TYPE, type Problem } from './problem.js'
import { problemMarkdown } from './problem_markdown.js'

/**
 * Renders a {@link Problem} as the body of the media type it is registered under with
 * `.errorHandling(e => e.serializer(mediaType, serialize))`.
 */
export type ProblemSerializer = (ctx: IContext, problem: Problem) => string

/** A serializer and the media type it is sent as, which is the response's `Content-Type`. */
export interface ProblemFormat {
  mediaType: string
  serialize: ProblemSerializer
}

const serializeJSON: ProblemSerializer = (_ctx, problem) => JSON.stringify(problem)

/**
 * The formats every application offers, keyed by {@link mediaTypeEssence}: `application/json`,
 * `application/problem+json` and `text/markdown`. `application/json` comes first, so it is the one a request
 * that names no format gets.
 */
export function defaultProblemFormats(): Map<string, ProblemFormat> {
  return new Map([
    ['application/json', { mediaType: 'application/json', serialize: serializeJSON }],
    [PROBLEM_CONTENT_TYPE, { mediaType: PROBLEM_CONTENT_TYPE, serialize: serializeJSON }],
    ['text/markdown', { mediaType: 'text/markdown', serialize: problemMarkdown }],
  ])
}

/** The `type/subtype` of a media type, lower-cased and without its parameters. */
export function mediaTypeEssence(mediaType: string): string {
  return mediaType.replace(/;.*$/s, '').trim().toLowerCase()
}

/**
 * Picks the format `accept` prefers among `formats`: the highest `q`, then an exact type over a wildcard, then the
 * first listed. Parameters other than `q` are ignored, so `text/markdown; charset=utf-8` asks for Markdown.
 *
 * The first format when the header is absent, is a lone wildcard, or names nothing offered: an error is answered
 * whatever the client accepts.
 */
export function negotiateProblemFormat(
  accept: string | undefined,
  formats: ReadonlyMap<string, ProblemFormat>,
): ProblemFormat {
  const essences = [...formats.keys()]
  const headers = accept === undefined ? {} : { accept: withoutParameters(accept) }
  const chosen = new Negotiator({ headers }).mediaType(essences) ?? essences[0]

  return formats.get(chosen) as ProblemFormat
}

// Negotiator matches the parameters of a range too, and `text/markdown; charset=utf-8` would match nothing offered.
function withoutParameters(accept: string): string {
  return accept
    .split(',')
    .map(range => {
      const [type = '', ...parameters] = range.split(';')
      const q = parameters.map(parameter => parameter.trim()).find(parameter => /^q=/i.test(parameter))
      return q === undefined ? type.trim() : `${type.trim()};${q}`
    })
    .join(',')
}
