import { errMessage } from '@caffeinejs/std/err'

const PACKAGE = '@caffeinejs/templating'

export class ErrTemplateConfiguration extends Error {
  override readonly name = 'ErrTemplateConfiguration'
  readonly code = 'ERR_TEMPLATE_CONFIGURATION'

  constructor(message: string) {
    super(errMessage(message).reference(PACKAGE, ErrTemplateConfiguration).build())
  }
}

export class ErrTemplateNotFound extends Error {
  override readonly name = 'ErrTemplateNotFound'
  readonly code = 'ERR_TEMPLATE_NOT_FOUND'

  constructor(readonly template: string) {
    super(errMessage(`Cannot find template "${template}"`).reference(PACKAGE, ErrTemplateNotFound).build())
  }
}

export class ErrTemplateRender extends Error {
  override readonly name = 'ErrTemplateRender'
  readonly code = 'ERR_TEMPLATE_RENDER'

  constructor(
    readonly template: string,
    readonly engine?: string,
    readonly partial?: string,
  ) {
    super(
      errMessage(
        `Cannot render template "${template}"${engine ? ' with "' + engine + '"' : ''}` +
          (partial === undefined ? '' : `: partial "${partial}" is not declared`),
      )
        .reference(PACKAGE, ErrTemplateRender)
        .build(),
    )
  }
}

export class ErrTemplateLimit extends Error {
  override readonly name = 'ErrTemplateLimit'
  readonly code = 'ERR_TEMPLATE_LIMIT'

  constructor(message: string) {
    super(errMessage(message).reference(PACKAGE, ErrTemplateLimit).build())
  }
}

export class ErrTemplateCapacity extends Error {
  override readonly name = 'ErrTemplateCapacity'
  readonly code = 'ERR_TEMPLATE_CAPACITY'

  constructor() {
    super(
      errMessage('Cannot prepare another template: renderer has eight active builds')
        .reference(PACKAGE, ErrTemplateCapacity)
        .build(),
    )
  }
}
