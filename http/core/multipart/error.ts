/** A multipart message has invalid syntax, exceeded a limit or has the wrong media type. */
export class ErrMultipart extends Error {
  readonly code = 'ERR_MULTIPART'

  constructor(
    readonly reason: 'syntax' | 'limit' | 'media-type',
    message: string,
  ) {
    super(message)
    this.name = 'ErrMultipart'
  }
}
