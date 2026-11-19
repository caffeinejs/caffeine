import { HEADER_NAME } from '../server/header_fields.js'
import { snapshotMultipartLimits, type MultipartLimits } from './limits.js'

/** The multipart subtype a route admits and its overrides of the server's multipart limits. */
export interface MultipartInput {
  readonly subtype: string
  readonly limits?: MultipartLimits
}

/** Snapshots a route's declaration. The exact wildcard accepts any multipart subtype. */
export function normalizeMultipartInput(input: MultipartInput): MultipartInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Object.hasOwn(input, 'subtype') ||
    Reflect.ownKeys(input).some(key => key !== 'subtype' && key !== 'limits')
  ) {
    throw new TypeError('A multipart input needs a subtype and accepts only optional limits')
  }

  const { subtype } = input
  if (typeof subtype !== 'string' || !HEADER_NAME.test(subtype) || (subtype.includes('*') && subtype !== '*')) {
    throw new TypeError('A multipart subtype must be an ASCII token without parameters or the exact wildcard "*"')
  }

  const limits = Object.hasOwn(input, 'limits') ? input.limits : undefined
  return Object.freeze({
    subtype: subtype.toLowerCase(),
    limits: limits === undefined ? undefined : snapshotMultipartLimits(limits),
  })
}
