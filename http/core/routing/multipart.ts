import { normalizeMultipartInput, type MultipartInput } from '../multipart/multipart.js'
import { configurationError } from '../server/error.js'

/** Compiles the multipart body declaration and the media type the route advertises together. */
export function compileMultipartDeclaration(
  input: MultipartInput,
  accept: readonly string[],
  owner: string,
): { multipart: MultipartInput; accept: string[] } {
  let multipart: MultipartInput
  try {
    multipart = normalizeMultipartInput(input)
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err
    }
    throw configurationError(
      `Cannot configure ${owner}: ${err.message}`,
      'Supply a subtype such as "form-data" and valid multipart limits',
    )
  }

  const mediaType = `multipart/${multipart.subtype}`
  if (accept.some(declared => typeof declared !== 'string' || declared.toLowerCase() !== mediaType)) {
    throw configurationError(
      `Cannot configure ${owner}: its consumes declarations disagree with its multipart subtype`,
      `Remove the conflicting consumes declaration or declare only "${mediaType}"`,
    )
  }
  return { multipart, accept: [mediaType] }
}
